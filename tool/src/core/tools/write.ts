import type { AgentTool } from '@mariozechner/pi-agent-core';
import { type Static, Type } from '@sinclair/typebox';
import { mkdir as fsMkdir, writeFile as fsWriteFile } from 'fs/promises';
import { dirname } from 'path';
import { withFileMutationQueue } from './file-mutation-queue.js';
import { resolveToCwd } from './path-utils.js';

const writeSchema = Type.Object({
  path: Type.String({ description: 'Path to the file to write (relative or absolute)' }),
  content: Type.String({ description: 'Content to write to the file' })
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;

  mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
  writeFile: (path, content) => fsWriteFile(path, content, 'utf-8'),
  mkdir: dir => fsMkdir(dir, { recursive: true }).then(() => {})
};

export interface WriteToolOptions {
  operations?: WriteOperations;
}

export function createWriteTool(cwd: string, options?: WriteToolOptions): AgentTool<typeof writeSchema> {
  const ops = options?.operations ?? defaultWriteOperations;

  return {
    name: 'write',
    label: 'write',
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    execute: async (_toolCallId: string, { path, content }: { path: string; content: string }, signal?: AbortSignal) => {
      const absolutePath = resolveToCwd(path, cwd);
      const dir = dirname(absolutePath);

      return withFileMutationQueue(
        absolutePath,
        () =>
          new Promise<{ content: Array<{ type: 'text'; text: string }>; details: undefined }>((resolve, reject) => {
            if (signal?.aborted) {
              reject(new Error('Operation aborted'));
              return;
            }

            let aborted = false;

            const onAbort = () => {
              aborted = true;
              reject(new Error('Operation aborted'));
            };

            if (signal) {
              signal.addEventListener('abort', onAbort, { once: true });
            }

            (async () => {
              try {
                await ops.mkdir(dir);

                if (aborted) {
                  return;
                }

                await ops.writeFile(absolutePath, content);

                if (aborted) {
                  return;
                }

                if (signal) {
                  signal.removeEventListener('abort', onAbort);
                }

                resolve({
                  content: [{ type: 'text', text: `Successfully wrote ${content.length} bytes to ${path}` }],
                  details: undefined
                });
              } catch (error: any) {
                if (signal) {
                  signal.removeEventListener('abort', onAbort);
                }

                if (!aborted) {
                  reject(error);
                }
              }
            })();
          })
      );
    }
  };
}

export const writeTool = createWriteTool(process.cwd());
