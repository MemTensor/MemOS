import { runHook } from '../_shared/hooks.ts';
export { profile } from './profile.ts';
if (import.meta.main) await runHook('codebuddy-cli');
