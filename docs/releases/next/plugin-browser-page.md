Выполняется на сервере BB. Зависимостей нет. Новый компонент: ставится только с согласия
пользователя (`run … --install`).

Плагин-навык для машин, где Browser Automation не запускается (на Windows у DevBrowser нет
сборки): скрипт `bb-page.mjs` штатными командами `bb browser` получает вкладку встроенного
браузера и даёт агенту переход, текст страницы, список и нажатие элементов, ввод и снимок.
На установках только с Linux и macOS он не нужен: записать `not-applicable`.

Уже применено, если установлен `browser-page` 0.1.0 из этого checkout. Данных и настроек у
плагина нет.
Проверка в треде на машине с окном BB:
`node plugins/browser-page/skills/browser-page/bb-page.mjs open https://example.com`, затем
`… text` и `… close`. Повтор безопасен. Откат: `bb plugin uninstall browser-page`.