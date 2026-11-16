# Config Updates

Плагин BB: сообщает о новых стабильных релизах этого репозитория и запускает их
применение агентом.

- Проверяет опубликованные GitHub Releases `vX.Y.Z` каждые шесть часов и по
  запросу. Draft, prerelease и коммиты `main` не учитываются.
- Показывает версию, описание и кнопку «Обновить с ИИ» в карточке над нижним
  рядом боковой панели и в настройках плагина; сам ничего не ставит.
- Кнопка создаёт тред агента с закреплёнными тегом и коммитом. Агент применяет
  шаги релиза через `scripts/updates.py` и ведёт локальный журнал.
- Ошибка сети показывается как ошибка проверки.

## Установка

Нужны BB 0.49+, Node.js 22+, npm, Python 3 и git на машине сервера BB. Плагин
ставится из checkout репозитория: рядом с ним должен быть `scripts/updates.py`.
Checkout должен быть подключён к BB как проект — в нём создаётся тред обновления.

```sh
npm --prefix plugins/config-updates ci --include=dev
bb plugin build plugins/config-updates
bb plugin install path:"$PWD/plugins/config-updates"
bb config-updates check
```

Обновление плагина: сборка и `bb plugin reload config-updates`.
Проверки: `npm test`, `npm run typecheck`.

Порядок применения и публикации релизов — [docs/updates.md](../../docs/updates.md).
