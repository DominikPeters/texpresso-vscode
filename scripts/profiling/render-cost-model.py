#!/usr/bin/env python3
"""Offline, dependency-free rendering-cost regression; never used by Auto.

No current patch flag, encoded bytes, measured timings or document identifiers
are input features. Splits and normalization operate on whole held-out projects.
Models predict native + host + webview work, excluding compilation and the
separately measured feature acquisition pass. Pairwise decisions are an offline
steady-codec comparison, not a simulation of switching caches during editing.
"""
import argparse
from collections import Counter, defaultdict
import json
import math
from pathlib import Path

ALPHAS = (0.1, 1.0, 10.0, 100.0)
VARIANTS = ('constant', 'scalar', 'content')
COUNTERS = ('glyphs', 'uniqueGlyphs', 'textSpans', 'fonts', 'fontOverflow',
            'glyphOverflow', 'paths', 'pathBytes', 'images', 'imagePixels',
            'clips', 'groups', 'shades', 'vectorCost', 'svgEligible')


def raster_size(bounds, requested):
    width, height = bounds[2] - bounds[0], bounds[3] - bounds[1]
    scale = min(requested / width, math.sqrt(4000000 / (width * height)), 8192 / max(width, height))
    w = max(1, min(8192, math.floor(width * scale + 1e-6)))
    h = max(1, min(8192, math.ceil(height * w / width)))
    while w * h > 4000000:
        w -= 1
        h = max(1, min(8192, math.ceil(height * w / width)))
    return w, h


def extract(paths, groups=None):
    observations, audit = [], Counter()
    for path in paths:
        with Path(path).open() as stream:
            for line in stream:
                row = json.loads(line)
                audit['completedSessions'] += 1
                if row['warmup']:
                    audit['warmupSessions'] += 1
                    continue
                if row.get('hidden') or row.get('errors') or any(v['state'] == 'hidden' for v in row.get('visibility', [])):
                    audit['invalidSessions'] += 1
                    continue
                codec = row['codec']
                if codec not in ('png', 'svg'):
                    raise ValueError('Paired study requires forced PNG and SVG')
                costs = {c['id']: c for c in row['costObservations'] if c['page'] == row['focusPage']}
                selected = [(i['frameId'], i['kind'] + ':' + str(i['sequence'])) for i in row['inputs']]
                first = next((c for c in row['costObservations'] if c['page'] == row['focusPage'] and c['sequence'] == 1), None)
                if first:
                    selected.insert(0, (first['id'], 'first'))
                for frame_id, phase in selected:
                    c = costs.get(frame_id)
                    if not c:
                        audit['missingCostObservation'] += 1
                        continue
                    if c['codec'] != codec:
                        audit['actualCodecFallback'] += 1
                        continue
                    f = c['features']
                    if f.get('schema') != 1 or not all(k in f for k in COUNTERS):
                        raise ValueError('Missing feature schema/counters')
                    if not f['svgEligible'] or f['fontOverflow'] or f['glyphOverflow']:
                        audit['ineligibleOrCappedFeatures'] += 1
                        continue
                    work = [c[n] for n in ('native', 'host', 'webview')]
                    if not all(isinstance(v, (float, int)) and math.isfinite(v) and 0 <= v < 1e9 for v in work):
                        raise ValueError('Invalid rendering-cost target')
                    allocation = c.get('allocation', '').split(':')
                    if len(allocation) != 3 or not all(math.isfinite(float(v)) and 0 < float(v) < 1e12 for v in allocation):
                        audit['missingAllocation'] += 1
                        continue
                    physical_width, _, quota = map(float, allocation)
                    bounds = c['bounds']
                    physical_height = physical_width * (bounds[3] - bounds[1]) / (bounds[2] - bounds[0])
                    rw, rh = raster_size(bounds, c['requestWidth'])
                    previous = c.get('previousFeatures') or {}
                    project = (groups or {}).get(row['fixture'], row['fixture'])
                    observations.append({
                        'project': project, 'fixture': row['fixture'], 'width': row['width'], 'dpr': row['dpr'],
                        'repeat': row['repeat'], 'phase': phase, 'codec': codec, 'id': frame_id,
                        'key': [row['fixture'], row['width'], row['dpr'], row['repeat'], phase],
                        'features': f, 'bounds': bounds, 'rasterPixels': rw * rh,
                        'physicalPixels': physical_width * physical_height, 'quota': quota,
                        'pngAtDisplayDensity': rw >= physical_width * .98,
                        'baseAvailable': bool(c.get(codec + 'BaseAvailable')),
                        'historyKnown': bool(previous),
                        'newGlyphs': max(0, f['uniqueGlyphs'] - previous.get('uniqueGlyphs', f['uniqueGlyphs'])),
                        'actualPatch': c['patch'], 'workMs': sum(work), 'componentsMs': work,
                        'featureMs': c['featureMs'], 'featureCached': c['featureCached']})
    audit['observations'] = len(observations)
    return observations, dict(audit)


def feature_vector(row, variant):
    f = row['features']
    state = [float(row['baseAvailable'])]
    if variant == 'constant':
        return state
    pixels = [math.log1p(row['rasterPixels']), math.log1p(row['physicalPixels'])]
    if variant == 'scalar':
        return [math.log1p(f['vectorCost'])] + pixels + state
    if variant == 'content':
        return [math.log1p(f[k]) for k in ('glyphs', 'uniqueGlyphs', 'textSpans', 'fonts', 'paths', 'pathBytes')] + pixels + state + [math.log1p(row['newGlyphs'])]
    raise ValueError('Unknown model')


def solve(matrix, target):
    a = [list(row) + [value] for row, value in zip(matrix, target)]
    n = len(a)
    for col in range(n):
        pivot = max(range(col, n), key=lambda i: abs(a[i][col]))
        if abs(a[pivot][col]) < 1e-12:
            raise ValueError('Singular regression system')
        a[col], a[pivot] = a[pivot], a[col]
        scale = a[col][col]
        a[col] = [v / scale for v in a[col]]
        for i in range(n):
            if i != col:
                scale = a[i][col]
                a[i] = [x - scale * y for x, y in zip(a[i], a[col])]
    return [row[-1] for row in a]


def fit(rows, variant, alpha):
    if not rows:
        raise ValueError('No training observations')
    counts = Counter(r['project'] for r in rows)
    weights = [1 / counts[r['project']] for r in rows]
    total = sum(weights)
    raw = [feature_vector(r, variant) for r in rows]
    columns = list(zip(*raw))
    means = [sum(w * x for w, x in zip(weights, col)) / total for col in columns]
    scales = [max(1e-8, math.sqrt(sum(w * (x - mean) ** 2 for w, x in zip(weights, col)) / total))
              for col, mean in zip(columns, means)]
    x = [[1.0] + [(v - m) / s for v, m, s in zip(row, means, scales)] for row in raw]
    n = len(x[0])
    matrix = [[sum(w * row[i] * row[j] for w, row in zip(weights, x)) + (alpha if i == j and i else 0)
               for j in range(n)] for i in range(n)]
    target = [sum(w * row[i] * sample['workMs'] for w, row, sample in zip(weights, x, rows)) for i in range(n)]
    return {'variant': variant, 'alpha': alpha, 'means': means, 'scales': scales,
            'coefficients': solve(matrix, target), 'trainingProjects': sorted(counts)}


def predict(model, row):
    x = [1.0] + [(v - m) / s for v, m, s in zip(feature_vector(row, model['variant']), model['means'], model['scales'])]
    return max(.05, sum(a * b for a, b in zip(model['coefficients'], x)))


def project_mean(rows, value):
    groups = defaultdict(list)
    for row in rows:
        groups[row['project']].append(value(row))
    return sum(sum(v) / len(v) for v in groups.values()) / len(groups) if groups else None


def tune(rows, variant):
    projects = sorted({r['project'] for r in rows})
    if len(projects) < 3:
        raise ValueError('Nested tuning needs at least three training projects')
    scores = []
    for alpha in ALPHAS:
        errors = []
        for held in projects:
            train = [r for r in rows if r['project'] != held]
            models = {c: fit([r for r in train if r['codec'] == c], variant, alpha) for c in ('png', 'svg')}
            test = [r for r in rows if r['project'] == held]
            errors.append(sum((predict(models[r['codec']], r) - r['workMs']) ** 2 for r in test) / len(test))
        scores.append({'alpha': alpha, 'projectMse': sum(errors) / len(errors)})
    chosen = min(scores, key=lambda s: (s['projectMse'], -s['alpha']))['alpha']
    return chosen, scores


def make_pairs(rows):
    grouped = defaultdict(dict)
    for row in rows:
        key = tuple(row['key'])
        if row['codec'] in grouped[key]:
            raise ValueError('Duplicate paired observation: ' + repr(key))
        grouped[key][row['codec']] = row
    pairs, audit = [], Counter()
    for key, pair in grouped.items():
        if set(pair) != {'png', 'svg'}:
            audit['missingCodecPartner'] += 1
            continue
        png, svg = pair['png'], pair['svg']
        if png['features'] != svg['features'] or any(abs(a - b) > .001 for a, b in zip(png['bounds'], svg['bounds'])):
            audit['differentCompiledContent'] += 1
            continue
        if not png['pngAtDisplayDensity']:
            audit['pngNeedsRefinement'] += 1
            continue
        pairs.append(pair)
    audit['densityEquivalentPairs'] = len(pairs)
    return pairs, dict(audit)


def choose(png, svg):
    # Prefer existing SVG policy when predicted differences are small. This
    # fixed margin is not a statistical confidence interval.
    return 'png' if png + max(3, .2 * min(png, svg)) < svg else 'svg'


def evaluate(rows):
    projects = sorted({r['project'] for r in rows})
    if len(projects) < 4:
        raise ValueError('Need at least four independent projects for nested held-out evaluation')
    predictions, folds = [], []
    for held in projects:
        train, test = [r for r in rows if r['project'] != held], [r for r in rows if r['project'] == held]
        for variant in VARIANTS:
            alpha, tuning = tune(train, variant)
            models = {codec: fit([r for r in train if r['codec'] == codec], variant, alpha) for codec in ('png', 'svg')}
            folds.append({'heldOutProject': held, 'variant': variant, 'alpha': alpha, 'innerValidation': tuning, 'models': models})
            for row in test:
                predictions.append({'project': held, 'key': row['key'], 'codec': row['codec'], 'variant': variant,
                                    'actualMs': row['workMs'], 'predictedMs': predict(models[row['codec']], row),
                                    'actualPatch': row['actualPatch']})
    lookup = {(p['variant'], tuple(p['key']), p['codec']): p['predictedMs'] for p in predictions}
    pairs, pairing = make_pairs(rows)
    decisions = []
    for pair in pairs:
        png, svg = pair['png'], pair['svg']
        options = {c: pair[c]['workMs'] for c in ('png', 'svg')}
        for variant in (*VARIANTS, 'always-png', 'always-svg'):
            codec = variant.removeprefix('always-') if variant.startswith('always-') else choose(
                lookup[variant, tuple(png['key']), 'png'], lookup[variant, tuple(svg['key']), 'svg'])
            decisions.append({'project': png['project'], 'key': png['key'], 'variant': variant, 'selected': codec,
                              'costMs': options[codec], 'oracleMs': min(options.values()),
                              'featureMs': pair[codec]['featureMs'] if variant in ('scalar', 'content') else 0,
                              'regretMs': options[codec] - min(options.values())})
    summary = []
    for variant in (*VARIANTS, 'always-png', 'always-svg'):
        p = [r for r in predictions if r['variant'] == variant]
        d = [r for r in decisions if r['variant'] == variant]
        summary.append({'variant': variant, 'observations': len(p), 'pairs': len(d),
                        'projectMaeMs': project_mean(p, lambda r: abs(r['actualMs'] - r['predictedMs'])),
                        'projectRmseMs': math.sqrt(project_mean(p, lambda r: (r['actualMs'] - r['predictedMs']) ** 2)) if p else None,
                        'projectRenderMs': project_mean(d, lambda r: r['costMs']),
                        'projectFeatureMs': project_mean(d, lambda r: r['featureMs']),
                        'projectRenderPlusFeaturesMs': project_mean(d, lambda r: r['costMs'] + r['featureMs']),
                        'projectRegretMs': project_mean(d, lambda r: r['regretMs']),
                        'projectPngFraction': project_mean(d, lambda r: float(r['selected'] == 'png')),
                        'projects': [{'project': project, 'regretMs': project_mean([r for r in d if r['project'] == project], lambda r: r['regretMs'])}
                                     for project in projects]})
    comparisons = []
    for baseline in ('scalar', 'constant', 'always-png', 'always-svg'):
        deltas = []
        for project in projects:
            rich = [r for r in decisions if r['variant'] == 'content' and r['project'] == project]
            other = [r for r in decisions if r['variant'] == baseline and r['project'] == project]
            if rich and other:
                deltas.append({'project': project, 'savingMs': project_mean(other, lambda r: r['costMs'] + r['featureMs']) -
                               project_mean(rich, lambda r: r['costMs'] + r['featureMs'])})
        values = [r['savingMs'] for r in deltas]
        comparisons.append({'baseline': baseline, 'projectSavings': deltas,
                            'meanSavingMs': sum(values) / len(values) if values else None,
                            'projectsImproved': sum(v > 0 for v in values),
                            'leaveOneProjectOutMeanRangeMs': [min((sum(values)-v)/(len(values)-1) for v in values),
                                                            max((sum(values)-v)/(len(values)-1) for v in values)] if len(values) > 1 else None})
    return {'schema': 1, 'projects': projects, 'pairingAudit': pairing, 'summary': summary,
            'comparisonsIncludingFeatureAcquisition': comparisons,
            'folds': folds, 'predictions': predictions, 'decisions': decisions,
            'limits': ['Exploratory, single-machine corpus; edits within a project are correlated.',
                       'All scaling and regularization tuning excludes the outer held-out project.',
                       'Decision pairs require matching page counters and full-density PNG; detail-refinement cost is not modeled.',
                       'Actual patch flags and timings are targets/diagnostics, never predictive features.',
                       'Paired forced-codec histories do not simulate switching penalties or a deployed controller.',
                       'No current-Auto replay is inferred from these forced-codec runs.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sessions', nargs='*', type=Path)
    parser.add_argument('--observations', type=Path, help='Rerun evaluation from sanitized extracted observations, without private projects')
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--groups', type=Path, help='Optional JSON map of fixture IDs to independent project/family IDs')
    args = parser.parse_args()
    if bool(args.sessions) == bool(args.observations):
        parser.error('Supply raw session files or --observations, exclusively')
    groups = json.loads(args.groups.read_text()) if args.groups else None
    if args.observations:
        rows = [json.loads(line) for line in args.observations.read_text().splitlines() if line]
        if groups:
            rows = [{**row, 'project': groups.get(row['fixture'], row['project'])} for row in rows]
        audit = {'preExtractedObservations': len(rows)}
    else:
        rows, audit = extract(args.sessions, groups)
    result = evaluate(rows)
    result['extractionAudit'] = audit
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'observations.jsonl').write_text(''.join(json.dumps(r, separators=(',', ':')) + '\n' for r in rows))
    (args.output / 'evaluation.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'audit': audit, 'pairing': result['pairingAudit'], 'summary': result['summary']}, indent=2))


if __name__ == '__main__':
    main()
