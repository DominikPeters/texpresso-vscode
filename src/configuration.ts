import type * as vscode from 'vscode';
import * as path from 'path';
import { SessionPaths } from './paths';

export type PackageProvider = 'auto' | 'texlive' | 'tectonic';

export interface SessionConfiguration {
  command: string;
  useWSL: boolean;
  useChangeRangeMode: boolean;
  packageProvider: PackageProvider;
  includeDirectories: string[];
  arguments: string[];
}

export interface LaunchCommand {
  command: string;
  args: string[];
  cwd?: string;
}

// Read settings for the root document on every start, including multi-root workspaces.
export function readConfiguration(configuration: vscode.WorkspaceConfiguration): SessionConfiguration {
  return {
    command: configuration.get<string>('command', 'texpresso'),
    useWSL: configuration.get<boolean>('useWSL', false),
    useChangeRangeMode: configuration.get<boolean>('useChangeRangeMode', false),
    packageProvider: configuration.get<PackageProvider>('packageProvider', 'auto'),
    includeDirectories: configuration.get<string[]>('includeDirectories', []),
    arguments: configuration.get<string[]>('arguments', [])
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
    } else if (argument === '-texlive' || argument === '-tectonic') {
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
    throw new Error('Choose either -texlive or -tectonic in TeXpresso additional arguments.');
  }
  for (const directory of config.includeDirectories) {
    args.push('-I', paths.includeDirectory(directory));
  }
  args.push('-json');
  if (config.useChangeRangeMode) {
    args.push('-lines');
  }
  args.push(paths.rootEnginePath);
  return config.useWSL
    ? { command: 'wsl', args: ['-e', config.command, ...args] }
    : { command: config.command, args, cwd: path.dirname(paths.rootEditorPath) };
}
