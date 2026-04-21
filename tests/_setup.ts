/**
 * Mocha root setup. Registers the `vscode` module stub into Node's module
 * cache BEFORE any production source file is loaded by tests.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
import { vscodeMock } from './vscodeMock';

// Intercept `require('vscode')` by hooking the Module class's _load. Modern
// Node exposes `_load` on the Module *namespace* as a getter, but the
// underlying writable function lives on the class itself
// (require('module').Module._load).
const ModuleMod = require('module');
const ModuleClass: any = ModuleMod.Module ?? ModuleMod;
const origLoad = ModuleClass._load.bind(ModuleClass);
ModuleClass._load = function (request: string, parent: any, isMain: boolean): unknown {
    if (request === 'vscode') {
        return vscodeMock;
    }
    return origLoad(request, parent, isMain);
};
