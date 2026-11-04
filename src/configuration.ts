import type * as vscode from 'vscode';
import * as path from 'path';
import { SessionPaths } from './paths';
import { wslArguments } from './wsl';

export type PackageProvider = 'auto' | 'texlive' | 'miktex' | 'miktex-windows' | 'tectonic';

export interface SessionConfiguration {
  command: string;
  engineSource?: 'bundled' | 'custom' | 'path';
  engineRevision?: string;
  useWSL: boolean;
  wslDistribution?: string;
  useChangeRangeMode: boolean;
  packageProvider: PackageProvider;
  miktexAutoInstall?: boolean;
  miktexWindowsBin?: string;
  includeDirectories: string[];
  arguments: string[];
  autoRerun: boolean;
  watchDependencies: boolean;
  streamFiles: boolean;
  previewLocation?: 'auto' | 'editor' | 'window';
}

export interface LaunchCommand {
  command: string;
  args: string[];
  cwd?: string;
}

// Read settings for the root document on every start, including multi-root workspaces.
export function readConfiguration(configuration: vscode.WorkspaceConfiguration): SessionConfiguration {
  return {
    command: configuration.get<string>('command', ''),
    useWSL: configuration.get<boolean>('useWSL', false),
    wslDistribution: configuration.get<string>('wslDistribution', '').trim(),
    useChangeRangeMode: configuration.get<boolean>('useChangeRangeMode', false),
    packageProvider: configuration.get<PackageProvider>('packageProvider', 'auto'),
    miktexAutoInstall: configuration.get<boolean>('miktexAutoInstall', false),
    miktexWindowsBin: configuration.get<string>('miktexWindowsBin', '').trim(),
    includeDirectories: configuration.get<string[]>('includeDirectories', []),
    arguments: configuration.get<string[]>('arguments', []),
    autoRerun: configuration.get<boolean>('autoRerun', false),
    watchDependencies: configuration.get<boolean>('watchDependencies', true),
    streamFiles: configuration.get<boolean>('streamFiles', false),
    previewLocation: configuration.get<'auto' | 'editor' | 'window'>('previewLocation', 'auto')
  };
}

export function buildLaunchCommand(config: SessionConfiguration, paths: SessionPaths): LaunchCommand {
  const args: string[] = [];
  const providers = new Set<string>();
  for (let i = 0; i < config.arguments.length; i++) {
    const argument = config.arguments[i];
    if (argument === '-I') {
      const directory = config.arguments[++i];
      if (directory === undefined) {
        throw new Error('The -I argument needs a directory.');
      }
      args.push('-I', directory);
    } else if (argument === '-miktex-windows-bin') {
      const directory = config.arguments[++i];
      if (directory === undefined) { throw new Error('The -miktex-windows-bin argument needs a Windows directory.'); }
      if (!config.miktexWindowsBin) { args.push(argument, directory); }
    } else if (argument === '-headless' || argument === '-capabilities') {
      throw new Error('Use TeXpresso Preview Location in Settings instead of adding ' + argument + ' to arguments.');
    } else if (argument === '-stream') {
      throw new Error('Enable Stream Files in TeXpresso Settings instead of adding -stream to arguments.');
    } else if (argument === '-texlive' || argument === '-miktex' || argument === '-miktex-windows' || argument === '-tectonic') {
      if (config.packageProvider === 'auto') {
        providers.add(argument);
        args.push(argument);
      }
    } else {
      args.push(argument);
    }
  }
  if (config.packageProvider !== 'auto') {
    // Dedicated settings take precedence over equivalent legacy arguments.
    args.push('-' + config.packageProvider);
  }
  if (providers.size > 1) {
    throw new Error('Choose one of -texlive, -miktex, -miktex-windows or -tectonic in TeXpresso additional arguments.');
  }
  if (config.miktexAutoInstall) {
    if (config.packageProvider !== 'miktex' && config.packageProvider !== 'miktex-windows' &&
        !(config.packageProvider === 'auto' && (providers.has('-miktex') || providers.has('-miktex-windows')))) {
      throw new Error('Select MiKTeX explicitly before enabling automatic package installation.');
    }
    args.push('-miktex-auto-install');
  }
  if (config.miktexWindowsBin) {
    args.push('-miktex-windows-bin', config.miktexWindowsBin);
  }
  for (const directory of config.includeDirectories) {
    args.push('-I', paths.includeDirectory(directory));
  }
  args.push('-json');
  if (config.streamFiles) {
    args.push('-stream');
  }
  if (config.useChangeRangeMode) {
    args.push('-lines');
  }
  args.push(paths.rootEnginePath);
  return config.useWSL
    ? { command: 'wsl', args: wslArguments(config.command, args, config.wslDistribution) }
    : { command: config.command, args, cwd: path.dirname(paths.rootEditorPath) };
}
