import { createHooks } from '../../opencode-v1/extension/index.ts';
/** Kilo's documented PluginModule entry, using its independently installed SDK client. */
export default {id:'memos-project-memory',server:async(input:Parameters<typeof createHooks>[0])=>createHooks(input,undefined,'kilo-cli')};
