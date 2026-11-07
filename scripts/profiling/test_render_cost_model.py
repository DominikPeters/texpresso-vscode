import copy
import importlib.util
import math
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('render_cost_model', Path(__file__).with_name('render-cost-model.py'))
MODEL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODEL)


def sample(project, codec, glyphs=100, base=False):
    features = dict(schema=1, glyphs=glyphs, uniqueGlyphs=20, textSpans=10, fonts=3,
                    paths=2, pathBytes=100, images=0, imagePixels=0, clips=0, groups=0,
                    shades=0, vectorCost=20 * glyphs + 100, svgEligible=True,
                    fontOverflow=False, glyphOverflow=False)
    return dict(project=project, fixture=project, codec=codec, features=features,
                key=[project, 640, 2, 1, 'paced:' + str(int(base))], phase='paced',
                bounds=[0, 0, 600, 800], rasterPixels=2000000, physicalPixels=2000000,
                quota=32000000, pngAtDisplayDensity=True, baseAvailable=base,
                historyKnown=base, newGlyphs=0, actualPatch=base, featureMs=.1,
                workMs=(1 if codec == 'png' else 2) + math.log1p(glyphs) + (0 if base else 5))


class CostModelTests(unittest.TestCase):
    def test_ridge_recovers_a_known_cost_relationship(self):
        rows = [sample(str(i), 'png', glyphs) for i, glyphs in enumerate([10, 100, 1000, 10000])]
        for row in rows:
            row['workMs'] = 3 + 2 * math.log1p(row['features']['vectorCost'])
        fit = MODEL.fit(rows, 'scalar', 1e-6)
        unseen = sample('unseen', 'png', 500)
        self.assertAlmostEqual(MODEL.predict(fit, unseen), 3 + 2 * math.log1p(unseen['features']['vectorCost']), places=4)

    def test_outcomes_and_current_patch_flags_cannot_be_predictive_features(self):
        row = sample('paper', 'svg')
        changed = {**row, 'workMs':10000, 'actualPatch':True, 'bytes':999999, 'id':123}
        for variant in MODEL.VARIANTS:
            self.assertEqual(MODEL.feature_vector(row, variant), MODEL.feature_vector(changed, variant))

    def test_outer_held_out_targets_cannot_change_scaling_fit_or_tuning(self):
        rows = [sample(project, codec, glyphs, base)
                for project, glyphs in [('a', 10), ('b', 100), ('c', 1000), ('d', 10000)]
                for codec in ['png', 'svg'] for base in [False, True]]
        original = MODEL.evaluate(rows)
        changed = copy.deepcopy(rows)
        for row in changed:
            if row['project'] == 'd':
                row['workMs'] += 10000
        altered = MODEL.evaluate(changed)
        first = [f for f in original['folds'] if f['heldOutProject'] == 'd']
        second = [f for f in altered['folds'] if f['heldOutProject'] == 'd']
        self.assertEqual(first, second)
        for fold in first:
            for model in fold['models'].values():
                self.assertNotIn('d', model['trainingProjects'])

    def test_decision_pairs_reject_different_content_and_insufficient_png_density(self):
        rows = []
        for project in ['matching', 'different', 'low-density', 'missing']:
            rows += [sample(project, 'png'), sample(project, 'svg')]
        next(r for r in rows if r['project'] == 'different' and r['codec'] == 'svg')['features']['glyphs'] += 1
        next(r for r in rows if r['project'] == 'low-density' and r['codec'] == 'png')['pngAtDisplayDensity'] = False
        rows = [r for r in rows if not (r['project'] == 'missing' and r['codec'] == 'svg')]
        pairs, audit = MODEL.make_pairs(rows)
        self.assertEqual(len(pairs), 1)
        self.assertEqual(audit['differentCompiledContent'], 1)
        self.assertEqual(audit['pngNeedsRefinement'], 1)
        self.assertEqual(audit['missingCodecPartner'], 1)

    def test_raster_planner_respects_the_native_pixel_cap(self):
        width, height = MODEL.raster_size([0, 0, 612, 792], 4000)
        self.assertLessEqual(width * height, 4000000)
        self.assertGreater(width, 1700)
        self.assertEqual(MODEL.raster_size([0, 0, 600, 800], 1200), (1200, 1600))


if __name__ == '__main__':
    unittest.main()
