import type { BbPluginApi } from "@get-bb/plugin-sdk";
export default function projectOpen(bb: BbPluginApi) {
  bb.settings.define({
    finderHelper: { type: 'boolean', label: 'Локальный обработчик Finder установлен', default: false },
  });
}
