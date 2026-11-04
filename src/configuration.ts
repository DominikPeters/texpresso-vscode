import type * as vscode from 'vscode';
import * as path from 'path';
import { SessionPaths } from './paths';
import { wslArguments } from './wsl';

export type PackageProvider = 'texlive' | 'tectonic';

export interface SessionConfiguration {
  command: string;
  engineSource?: 'bundled' | 'custom' | 'path';
  engineRevision?: string;
  useWSL: boolean;
  wslDistribution?: string;
  useChangeRangeMode: boolean;
  packageProvider: PackageProvider;
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
  const savedProvider = configuration.get<string>('packageProvider', 'texlive');
  const packageProvider = savedProvider === 'auto' ? 'texlive' : savedProvider;
  if (packageProvider !== 'texlive' && packageProvider !== 'tectonic') {
    throw new Error('Select TeX Live or Tectonic in TeXpresso Package Provider settings.');
  }
  return {
    command: configuration.get<string>('command', ''),
    useWSL: configuration.get<boolean>('useWSL', false),
    wslDistribution: configuration.get<string>('wslDistribution', '').trim(),
    useChangeRangeMode: configuration.get<boolean>('useChangeRangeMode', false),
    packageProvider,
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
  for (let i = 0; i < config.arguments.length; i++) {
    const argument = config.arguments[i];
    if (argument === '-I') {
      const directory = config.arguments[++i];
      if (directory === undefined) {
        throw new Error('The -I argument needs a directory.');
      }
      args.push('-I', directory);
    } else if (argument === '-headless' || argument === '-capabilities') {
      throw new Error('Use TeXpresso Preview Location in Settings instead of adding ' + argument + ' to arguments.');
    } else if (argument === '-stream') {
      throw new Error('Enable Stream Files in TeXpresso Settings instead of adding -stream to arguments.');
    } else if (argument === '-texlive' || argument === '-tectonic') {
      // The dedicated setting takes precedence over legacy provider arguments.
    } else {
      args.push(argument);
    }
  }
  // Select explicitly so the shared engine cannot auto-detect a parked provider.
  args.push('-' + config.packageProvider);
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
