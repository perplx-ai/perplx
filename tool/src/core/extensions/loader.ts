import type { ExtensionFactory, ExtensionRuntime, LoadExtensionsResult } from './types.js';

export function createExtensionRuntime(): ExtensionRuntime {
  return { pendingProviderRegistrations: [] };
}

export function loadExtensions(): LoadExtensionsResult {
  return { extensions: [], errors: [], runtime: createExtensionRuntime() };
}

export function loadExtensionFromFactory(_factory: ExtensionFactory): never {
  throw new Error('Extensions are not supported');
}
