import type { BbPluginApi } from "@get-bb/plugin-sdk";
export default function projectOpen(bb: BbPluginApi) {
  bb.settings.define({
    finderHelper: { type: 'boolean', label: 'Локальный обработчик Finder установлен', default: false },
    placement: { type: 'select', label: 'Где показывать папку и терминал треда', default: 'row', options: ['row', 'menu'],
      experimental_optionLabels: { row: 'Кнопки в строке треда при наведении', menu: 'В меню «…» треда' },
      description: 'В меню «…» кнопки из строк убираются; отдельные действия можно вернуть в строку через Customize actions. В заголовке открытого треда кнопки есть всегда.' },
  });
}
