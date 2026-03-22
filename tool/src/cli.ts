#!/usr/bin/env node

process.title = 'perplx';
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { main } from './main.js';

setGlobalDispatcher(new EnvHttpProxyAgent());
main(process.argv.slice(2));
