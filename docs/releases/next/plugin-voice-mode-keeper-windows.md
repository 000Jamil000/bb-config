Выполняется на сервере BB. Зависимостей нет.

Plugin Keeper и `patch_keeper.py` работают и на Windows: настройка `pythonPath`, остановка
дерева процессов вместо группы, junction вместо симлинка на `node_modules`, наложение патча
на LF-копию исходников, которые Git for Windows выдаёт с CRLF. На Linux и macOS поведение
прежнее. Часть для Voice Mode (`auto_update.py`) на Windows не проверялась.

Уже применено, если установлен `voice-mode-keeper` 0.2.4 из этого checkout; если плагин не
установлен, шаг неприменим. Шаг пересобирает и перезагружает плагин; состояние в
`.local/plugin-patches/` сохраняется.
Проверка: `bb plugin rpc call voice-mode-keeper status --json` — у сопровождаемых плагинов
состояние `ready`. Повтор безопасен. Откат — по полю `rollback`.