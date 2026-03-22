import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';
import { spawn } from 'child_process';
import { waitForChildProcess } from '../../utils/child-process.js';
import { getShellConfig, getShellEnv, killProcessTree } from '../../utils/shell.js';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateTail } from './truncate.js';

function getTempFilePath(): string {
  const id = randomBytes(8).toString('hex');
  return join(tmpdir(), `perplx-bash-${id}.log`);
}

const bashSchema = Type.Object({
  command: Type.String({ description: 'Bash command to execute' }),
  timeout: Type.Optional(Type.Number({ description: 'Timeout in seconds (optional, no default timeout)' }))
});

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
  truncation?: TruncationResult;
  fullOutputPath?: string;
}

export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    }
  ) => Promise<{ exitCode: number | null }>;
}

export function createLocalBashOperations(): BashOperations {
  return {
    exec: (command, cwd, { onData, signal, timeout, env }) => {
      return new Promise((resolve, reject) => {
        const { shell, args } = getShellConfig();

        if (!existsSync(cwd)) {
          reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
          return;
        }

        const child = spawn(shell, [...args, command], {
          cwd,
          detached: true,
          env: env ?? getShellEnv(),
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let timedOut = false;

        let timeoutHandle: NodeJS.Timeout | undefined;
        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid) {
              killProcessTree(child.pid);
            }
          }, timeout * 1000);
        }

        if (child.stdout) {
          child.stdout.on('data', onData);
        }
        if (child.stderr) {
          child.stderr.on('data', onData);
        }

        const onAbort = () => {
          if (child.pid) {
            killProcessTree(child.pid);
          }
        };

        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }

        waitForChildProcess(child)
          .then(code => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (signal) signal.removeEventListener('abort', onAbort);

            if (signal?.aborted) {
              reject(new Error('aborted'));
              return;
            }

            if (timedOut) {
              reject(new Error(`timeout:${timeout}`));
              return;
            }

            resolve({ exitCode: code });
          })
          .catch(err => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (signal) signal.removeEventListener('abort', onAbort);
            reject(err);
          });
      });
    }
  };
}

export interface BashSpawnContext {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
  const baseContext: BashSpawnContext = {
    command,
    cwd,
    env: { ...getShellEnv() }
  };

  return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
  operations?: BashOperations;

  commandPrefix?: string;

  spawnHook?: BashSpawnHook;
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
  const ops = options?.operations ?? createLocalBashOperations();
  const commandPrefix = options?.commandPrefix;
  const spawnHook = options?.spawnHook;

  return {
    name: 'bash',
    label: 'bash',
    description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
    parameters: bashSchema,
    execute: async (_toolCallId: string, { command, timeout }: { command: string; timeout?: number }, signal?: AbortSignal, onUpdate?) => {
      const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
      const spawnContext = resolveSpawnContext(resolvedCommand, cwd, spawnHook);

      return new Promise((resolve, reject) => {
        let tempFilePath: string | undefined;
        let tempFileStream: ReturnType<typeof createWriteStream> | undefined;
        let totalBytes = 0;

        const chunks: Buffer[] = [];
        let chunksBytes = 0;

        const maxChunksBytes = DEFAULT_MAX_BYTES * 2;

        const handleData = (data: Buffer) => {
          totalBytes += data.length;

          if (totalBytes > DEFAULT_MAX_BYTES && !tempFilePath) {
            tempFilePath = getTempFilePath();
            tempFileStream = createWriteStream(tempFilePath);

            for (const chunk of chunks) {
              tempFileStream.write(chunk);
            }
          }

          if (tempFileStream) {
            tempFileStream.write(data);
          }

          chunks.push(data);
          chunksBytes += data.length;

          while (chunksBytes > maxChunksBytes && chunks.length > 1) {
            const removed = chunks.shift()!;
            chunksBytes -= removed.length;
          }

          if (onUpdate) {
            const fullBuffer = Buffer.concat(chunks);
            const fullText = fullBuffer.toString('utf-8');
            const truncation = truncateTail(fullText);
            onUpdate({
              content: [{ type: 'text', text: truncation.content || '' }],
              details: {
                truncation: truncation.truncated ? truncation : undefined,
                fullOutputPath: tempFilePath
              }
            });
          }
        };

        ops
          .exec(spawnContext.command, spawnContext.cwd, {
            onData: handleData,
            signal,
            timeout,
            env: spawnContext.env
          })
          .then(({ exitCode }) => {
            if (tempFileStream) {
              tempFileStream.end();
            }

            const fullBuffer = Buffer.concat(chunks);
            const fullOutput = fullBuffer.toString('utf-8');

            const truncation = truncateTail(fullOutput);
            let outputText = truncation.content || '(no output)';

            let details: BashToolDetails | undefined;

            if (truncation.truncated) {
              details = {
                truncation,
                fullOutputPath: tempFilePath
              };

              const startLine = truncation.totalLines - truncation.outputLines + 1;
              const endLine = truncation.totalLines;

              if (truncation.lastLinePartial) {
                const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split('\n').pop() || '', 'utf-8'));
                outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
              } else if (truncation.truncatedBy === 'lines') {
                outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
              } else {
                outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
              }
            }

            if (exitCode !== 0 && exitCode !== null) {
              outputText += `\n\nCommand exited with code ${exitCode}`;
              reject(new Error(outputText));
            } else {
              resolve({ content: [{ type: 'text', text: outputText }], details });
            }
          })
          .catch((err: Error) => {
            if (tempFileStream) {
              tempFileStream.end();
            }

            const fullBuffer = Buffer.concat(chunks);
            let output = fullBuffer.toString('utf-8');

            if (err.message === 'aborted') {
              if (output) output += '\n\n';
              output += 'Command aborted';
              reject(new Error(output));
            } else if (err.message.startsWith('timeout:')) {
              const timeoutSecs = err.message.split(':')[1];
              if (output) output += '\n\n';
              output += `Command timed out after ${timeoutSecs} seconds`;
              reject(new Error(output));
            } else {
              reject(err);
            }
          });
      });
    }
  };
}

export const bashTool = createBashTool(process.cwd());
