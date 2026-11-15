# Плагины для BB

Набор дополнений для [BB](https://getbb.app): вкладки машин, управление прокси
и небольшие кнопки к существующим возможностям приложения.
Устанавливайте только нужные плагины — импортировать настройки автора не требуется.

| Плагин | Что добавляет | Настройка после установки |
| --- | --- | --- |
| [Machine Tabs](plugins/machine-tabs) | Вкладки машин, группировку и оформление списка тредов | Выберите машины и вид списка |
| [Proxy Manager](plugins/proxy-manager) | Управление прокси, проверку соединений и маршрутов провайдеров | Добавьте собственные прокси и выберите маршруты |
| [Handoff Button](plugins/handoff-button) | Кнопку открытия оригинальной панели Handoff в composer | Установите оригинальный Handoff из каталога BB |
| [Web BB Button](plugins/web-bb-button) | Глобус в левой панели, открывающий BB в браузере | Укажите публичный URL своего BB в настройках плагина |

## Установка одного плагина

Нужны BB 0.49+, Node.js 22+ и npm на машине сервера BB.
Локальный путь установки должен быть доступен самому серверу BB.

```sh
git clone https://github.com/ainurminibaev/bb-config.git
cd bb-config
npm --prefix plugins/machine-tabs ci --include=dev
bb plugin build plugins/machine-tabs
bb plugin install path:"$PWD/plugins/machine-tabs"
```

Вместо `machine-tabs` подставьте `proxy-manager`, `handoff-button` или
`web-bb-button`. Для Handoff Button сначала установите оригинальный Handoff
из каталога BB. Его формы и логика переноса остаются в оригинальном плагине.

После установки откройте **Settings → Installed plugins**.
Web BB Button без адреса показывает **«Требуется настройка»**: заполните поле
**«Публичный адрес BB»**. Это адрес вашей установки, например
`https://example.getbb.app`, а не адрес этого репозитория.

Плагины, обращающиеся к разметке BB, могут требовать обновления после изменения
интерфейса приложения. Поддержка и ограничения описаны в README каждого плагина.
Отключение плагина выполняется через Settings → Installed plugins или
`bb plugin disable <id>`.

## Обновление

Из чистого checkout получите изменения и пересоберите нужный плагин:

```sh
git pull --ff-only
npm --prefix plugins/machine-tabs ci --include=dev
bb plugin build plugins/machine-tabs
bb plugin reload machine-tabs
```

## Личные настройки

Исходники и обезличенные примеры находятся в Git. Адреса серверов и прокси,
идентификаторы машин и личные инструкции сохраняются только в игнорируемой
`.local/config/`. Пароли и авторизации в снимок не включаются.

```sh
python3 scripts/snapshot.py --settings-only
python3 scripts/snapshot.py --check
python3 scripts/private_backup.py
```

Скрипт снимка не меняет публичный `config/`. Зашифрованную личную копию нужно
сохранять отдельно от репозитория. Подробности — в
[инструкции резервного копирования](docs/server-backups.md).

## Восстановление целой установки

Обычная установка отдельных плагинов не требует этих команд. Для восстановления
своего BB сначала верните собственную `.local/config/`, затем просмотрите план:

```sh
python3 scripts/restore.py --plugins
# После проверки плана, на машине сервера BB:
python3 scripts/restore.py --plugins --apply
```

Восстановление читает публичные примеры и личный слой с приоритетом личных
значений. Сетевые маршруты, учётные данные и новые идентификаторы машин требуют
ручной настройки. См. [подробную инструкцию](docs/customizations.md).

## Разработка

Перед публикацией изменений проверяйте текущие файлы и историю:

```sh
python3 scripts/privacy_check.py
python3 scripts/privacy_check.py --history
python3 -m unittest discover -s scripts -p 'test_*.py'
node --test plugins/web-bb-button/*.test.ts
```

Проверка по шаблонам помогает находить секреты и личные данные, но не заменяет
просмотр diff. Не добавляйте `.local/` в Git принудительно.

## Лицензия

Собственный код распространяется под [MIT](LICENSE). Зависимости и сторонние
плагины сохраняют свои лицензии и устанавливаются из собственных источников.
