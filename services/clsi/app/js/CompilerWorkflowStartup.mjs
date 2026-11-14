// @ts-check
// Evaluated before legacy execution modules, constructors, monitors or listeners.
import Settings from '@overleaf/settings'
import { requireLegacyCompilerStartup } from './CompilerWorkflowMode.ts'
requireLegacyCompilerStartup(Settings.compilerWorkflowMode)
