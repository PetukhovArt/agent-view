# PRD: agent-view

**Author:** PetukhovArt
**Date:** 2026-03-28
**Updated:** 2026-03-29
**Status:** Approved

---

## Problem Statement

AI-агенты (Claude Code) умеют писать и рефакторить код, но не умеют визуально верифицировать результат в desktop-приложениях. Существующие инструменты (dev-browser, Playwright MCP) работают только с обычным браузером и не поддерживают:

- **Electron** — multiwindow desktop-приложения с собственным Chromium
- **Tauri** — desktop-приложения на системном WebView (WebView2/WebKitGTK/WKWebView)
- **WebGL** — canvas-based UI (PixiJS, CesiumJS, Three.js), где accessibility tree бесполезен

Разработчик, работающий над SCADA-системой (Tauri + SolidJS + PixiJS) или видеоаналитикой (Electron + Vue 3 + CesiumJS), не может замкнуть агентную петлю «написал код → проверил визуально → поправил». Агент слеп к тому, что происходит на экране desktop-приложения и внутри WebGL-канваса.

## Success Metrics

| Metric | Target | How to Measure |
|--------|--------|----------------|
| Агент может получить DOM snapshot из Electron/Tauri-приложения | 100% успех на Windows | Ручной тест: discover → dom |
| Агент может получить PixiJS scene graph | Объекты с name, position, visible, tint | Ручной тест: scene --filter возвращает корректные данные |
| Время от вызова команды до получения результата | < 2 секунды (без launch) | Замер времени CLI-команд |
| Расход токенов на один snapshot | < 2000 токенов для типичной страницы | Подсчёт символов в stdout |
| Агент самостоятельно верифицирует UI после изменения кода | Корректно определяет затронутые области по git diff | Ручная проверка на пилотном проекте |

## Solution

**agent-view** — Claude Code skill, предоставляющий агенту набор CLI-команд для визуальной верификации desktop-приложений. Агент вызывает команды через bash, получает структурированные данные о состоянии UI (DOM accessibility tree, WebGL scene graph, скриншоты) и принимает решение о корректности изменений.

Ключевые принципы:

1. **CDP как единый протокол** — на Windows все три runtime (Browser, Electron, Tauri/WebView2) поддерживают Chrome DevTools Protocol, что позволяет использовать единый transport.

2. **Не пишем свои сериализаторы** — используем существующие devtools-пакеты движков (`@pixi/devtools`), читая данные, которые они выставляют на `window`, через CDP `Runtime.evaluate`.

3. **CLI-команды, не скрипты** — каждый вызов атомарный, минимум токенов. Lazy server под капотом держит CDP-соединения между вызовами.

4. **Агент решает что проверять** — по git diff определяет затронутые компоненты и вызывает нужные команды. Опциональный маппинг «файл → проверка» в конфиге для сложных случаев.

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | Целевая аудитория — JS/TS разработчики, максимальная скорость разработки |
| Runtime | Node.js | Зрелые CDP-библиотеки, npm-экосистема |
| CDP client | `chrome-remote-interface` | Легковесный, низкоуровневый, прямой доступ к CDP-доменам |
| Package manager | pnpm | Быстрый, строгий node_modules |
| Distribution | `npm install -g agent-view` | Глобальный CLI, минимум токенов на вызов |
| IPC (CLI ↔ Lazy Server) | TCP на localhost (порт 47922) | Простота, кросс-платформенность, нет проблем с правами |

## User Stories

**US-1:** Как разработчик, я хочу инициализировать agent-view в проекте одной командой, чтобы не тратить время на ручную конфигурацию.

**Acceptance Criteria:**
- [ ] `agent-view init` сканирует `package.json` и определяет runtime (tauri, electron, browser)
- [ ] `agent-view init` определяет WebGL-движок по зависимостям (pixi.js, cesium, three)
- [ ] `agent-view init` генерирует `agent-view.config.json` с корректными значениями по умолчанию
- [ ] Конфиг включает поле `launch` с командой запуска dev-сервера
- [ ] Конфиг включает поле `port` с CDP-портом (default: 9222)
- [ ] `init` полностью автоматический (без интерактивных prompts — агент не может отвечать на них)

---

**US-2:** Как AI-агент (Claude Code), я хочу обнаружить запущенное приложение и его окна, чтобы знать к чему подключаться.

**Acceptance Criteria:**
- [ ] `agent-view discover` возвращает JSON с runtime, port, список окон (id, title, url)
- [ ] Если приложение не запущено, возвращает понятное сообщение (не crash)
- [ ] Multiwindow: все открытые окна перечислены
- [ ] Формат вывода — JSON (единственная команда с JSON-выводом)

---

**US-3:** Как AI-агент, я хочу запустить приложение, если оно ещё не запущено, чтобы не зависеть от ручных действий разработчика.

**Acceptance Criteria:**
- [ ] `agent-view launch` запускает команду из `config.launch` как фоновый процесс
- [ ] Поллинг CDP-порта для определения readiness (приложение загрузилось)
- [ ] Таймаут с понятным сообщением, если приложение не стартовало за N секунд
- [ ] Повторный `launch` при уже запущенном приложении не создаёт дубль

---

**US-4:** Как AI-агент, я хочу получить DOM accessibility tree конкретного окна, чтобы видеть структуру UI-элементов (кнопки, формы, панели).

**Acceptance Criteria:**
- [ ] `agent-view dom` возвращает accessibility tree в компактном текстовом формате
- [ ] `agent-view dom --window <name|id>` адресует конкретное окно
- [ ] Элементы имеют session ref-идентификаторы (инкрементный ID, хранится в lazy server)
- [ ] `--filter <text>` фильтрует дерево по тексту/имени
- [ ] `--depth <N>` ограничивает глубину вложенности
- [ ] Вывод по умолчанию укладывается в ~1500 токенов для типичной страницы
- [ ] При невалидном ref возвращает понятную ошибку (агент делает повторный `dom`)

---

**US-5:** Как AI-агент, я хочу получить WebGL scene graph (PixiJS), чтобы видеть состояние объектов на канвасе (позиция, цвет, видимость).

**Acceptance Criteria:**
- [ ] `agent-view scene` возвращает сериализованное дерево PixiJS stage
- [ ] Каждый объект содержит: name, type, position (x, y), visible, tint
- [ ] `--filter <text>` фильтрует по name объекта
- [ ] `--depth <N>` ограничивает глубину обхода display tree
- [ ] `--verbose` добавляет расширенные свойства (scale, alpha, rotation, bounds)
- [ ] `--diff` возвращает только изменения относительно предыдущего вызова (кэш в памяти lazy server)
- [ ] Работает через чтение `window.__PIXI_DEVTOOLS__` via CDP `Runtime.evaluate`

---

**US-6:** Как AI-агент, я хочу получить DOM и scene graph одним вызовом, когда мне нужна полная картина.

**Acceptance Criteria:**
- [ ] `agent-view snap` возвращает DOM accessibility tree + WebGL scene graph в одном ответе
- [ ] Секции чётко разделены (DOM / Scene)
- [ ] Поддерживает те же флаги (`--filter`, `--depth`, `--window`)

---

**US-7:** Как AI-агент, я хочу сделать скриншот окна, чтобы визуально верифицировать UI.

**Acceptance Criteria:**
- [ ] `agent-view screenshot` сохраняет PNG и возвращает путь к файлу
- [ ] `--window <name|id>` для конкретного окна
- [ ] Скриншот включает содержимое WebGL canvas (CDP `Page.captureScreenshot`)

---

**US-8:** Как AI-агент, я хочу взаимодействовать с UI — кликать по элементам и вводить текст.

**Acceptance Criteria:**
- [ ] `agent-view click <ref>` кликает по элементу из accessibility tree по ref-идентификатору
- [ ] `agent-view fill <ref> <value>` вводит текст в поле
- [ ] `agent-view click --pos <x,y>` кликает по координатам (для canvas-элементов)
- [ ] Возвращает результат (success/error) в stdout

---

**US-9:** Как AI-агент, я хочу автоматически определять какие UI-области затронуты моими изменениями в коде, чтобы знать что проверять.

**Acceptance Criteria:**
- [ ] SKILL.md содержит инструкцию: «прочитай git diff → определи затронутые компоненты → вызови нужные команды»
- [ ] Опциональный маппинг в конфиге: `verify: { "src/components/Pump.tsx": { steps: [...] } }`
- [ ] Если маппинг есть — агент использует его; если нет — принимает решение сам
- [ ] Агент вызывает `agent-view` команды для затронутых областей и анализирует результат
- [ ] SKILL.md пишется после итерации 1 (когда базовые команды работают)

---

**US-10:** Как разработчик, я хочу минимально инструментировать своё приложение (одна строка кода), чтобы agent-view мог видеть WebGL scene graph.

**Acceptance Criteria:**
- [ ] Для PixiJS: `import '@pixi/devtools'` + `initDevtools({ app })` — достаточно
- [ ] Для Tauri: добавить `additionalBrowserArgs: "--remote-debugging-port=9222"` в tauri.conf.json
- [ ] Для Electron: добавить `--remote-debugging-port=9222` при запуске
- [ ] В README чётко описаны шаги подготовки для каждого runtime
- [ ] Инструментация не попадает в production build (dev-only)

## MVP Iterations

### Итерация 1 — Ядро (подключение и чтение DOM)
Команды: `init`, `discover`, `dom`, `stop`
Тестирование: ручное на `D:\web-projects\web-client` (Electron + Vue 3)

### Итерация 2 — Взаимодействие
Команды: `launch`, `click`, `fill`, `screenshot`

### Итерация 3 — WebGL
Команды: `scene`, `snap`, `--diff`
Тестирование: на SCADA-проекте (Tauri + SolidJS + PixiJS)

### Post-MVP
- SKILL.md для Claude Code (после итерации 1)
- Тестовые сценарии multiwindow / multi-monitor

## Module Architecture

### CLI (`agent-view`)

- **Responsibility:** Точка входа пользователя и агента. Парсит команды и аргументы, читает конфиг, передаёт параметры в lazy server, форматирует вывод в stdout.
- **Interface:** `agent-view <command> [options]`. Команды: `init`, `discover`, `launch`, `dom`, `scene`, `snap`, `screenshot`, `click`, `fill`, `stop`.
- **Dependencies:** Lazy Server (TCP), Config Manager.
- **Output format:** Плоский текст по умолчанию (LLM-friendly, минимум токенов). `discover` — JSON.
- **New / Modified:** New.

### Lazy Server

- **Responsibility:** Фоновый процесс, управляющий CDP-соединениями. Поднимается при первом вызове CLI, переиспользуется последующими, гасится по таймауту бездействия (5 минут). Хранит session ref маппинг и кэш snapshot'ов для `--diff` в памяти.
- **Interface:** TCP на localhost:47922. Принимает JSON-команды (CLI передаёт все параметры включая port/runtime в каждом запросе), возвращает JSON-результаты.
- **Multi-project:** Один сервер на все проекты, различает по CDP-порту.
- **Dependencies:** CDP Transport, Runtime Adapters, DOM Inspector, Scene Inspector.
- **New / Modified:** New.

### CDP Transport

- **Responsibility:** Абстракция подключения к приложению через Chrome DevTools Protocol. Управляет WebSocket-соединением, отправляет команды, получает ответы.
- **Interface:** `connect(port): Connection`, `evaluate(code): Result`, `getAccessibilityTree(): Tree`, `getTargets(): Target[]`. Интерфейс `Transport` позволяет в будущем подставить injected bridge вместо CDP.
- **Dependencies:** `chrome-remote-interface`.
- **New / Modified:** New.

### Runtime Adapters

- **Responsibility:** Discovery и подключение для каждого runtime. Определяет какой runtime запущен, находит CDP endpoint, перечисляет окна/targets.
- **Interface:** `discover(): RuntimeInfo`, `getWindows(): Window[]`, `connectWindow(id): Connection`. Каждый адаптер реализует единый интерфейс `RuntimeAdapter`.
- **Dependencies:** CDP Transport.
- **New / Modified:** New. Три реализации: BrowserAdapter, ElectronAdapter, TauriAdapter.

### DOM Inspector

- **Responsibility:** Получает accessibility tree через CDP, форматирует в компактный LLM-friendly текст с session ref-идентификаторами. Поддерживает фильтрацию по тексту и ограничение глубины.
- **Interface:** `getSnapshot(options: {filter?, depth?}): string`, `getRef(ref): ElementHandle`.
- **Dependencies:** CDP Transport.
- **New / Modified:** New.

### Scene Inspector

- **Responsibility:** Читает данные из `window.__PIXI_DEVTOOLS__` через CDP `Runtime.evaluate`. Сериализует PixiJS scene graph в компактный формат. Поддерживает фильтрацию, глубину, verbose, diff.
- **Interface:** `getSceneGraph(options: {filter?, depth?, verbose?, diff?}): string`. Интерфейс `SceneInspector` позволяет добавлять адаптеры для других движков (CesiumJS, Three.js).
- **Dependencies:** CDP Transport.
- **New / Modified:** New.

### Config Manager

- **Responsibility:** Чтение, валидация и автогенерация `agent-view.config.json`. Команда `init` сканирует `package.json` и генерирует конфиг автоматически (без интерактивных prompts).
- **Interface:** `readConfig(): Config`, `generateConfig(packageJson): Config`, `writeConfig(config): void`.
- **Dependencies:** Файловая система.
- **New / Modified:** New.

### Launcher

- **Responsibility:** Запускает приложение по команде из конфига как фоновый процесс. Поллит CDP-порт для определения readiness. Управляет lifecycle (не дублировать, таймаут).
- **Interface:** `launch(config): Promise<void>`, `isRunning(): boolean`, `stop(): void`.
- **Dependencies:** Config Manager, CDP Transport (для polling).
- **New / Modified:** New.

## Implementation Decisions

1. **CDP как единый transport на Windows** — все три runtime (Browser, Electron, Tauri/WebView2) поддерживают CDP на Windows. Это позволяет не писать отдельные протоколы для каждого runtime.
   - *Context:* WebView2 на Windows поддерживает `--remote-debugging-port`. Подтверждено proof-of-concept (Haprog/playwright-cdp).
   - *Trade-off:* На macOS/Linux Tauri (WKWebView, WebKitGTK) не поддерживает CDP. Потребуется альтернативный transport (injected bridge).
   - *Reversibility:* Средняя. Интерфейс `Transport` абстрагирует CDP, замена на bridge потребует новой реализации, но не изменения потребителей.

2. **CLI-команды вместо скриптов** — агент вызывает атомарные bash-команды, а не пишет JS-скрипты как в dev-browser.
   - *Context:* E2E-сценарии состоят из серии проверок. CLI-команды минимизируют расход токенов (~5 токенов на вызов vs ~50 на скрипт с boilerplate).
   - *Trade-off:* Меньше гибкости для сложных сценариев (нельзя написать цикл внутри одного вызова).
   - *Reversibility:* Лёгкая. Скриптовый режим можно добавить позже как дополнительную команду.

3. **Lazy server с auto-shutdown (5 минут)** — первый вызов CLI поднимает фоновый процесс, последующие переиспользуют. Shutdown по таймауту бездействия.
   - *Context:* Серия вызовов в e2e-сценарии требует persistent CDP-соединения. Overhead переподключения ~200-500ms на каждый вызов неприемлем.
   - *Trade-off:* Висящий фоновый процесс. Потенциальные проблемы с orphaned processes.
   - *Reversibility:* Средняя. Можно переключить на stateless режим с флагом.

4. **Использование существующих devtools-пакетов движков** — не пишем свои сериализаторы scene graph, а читаем данные из `window.__PIXI_DEVTOOLS__` через CDP.
   - *Context:* `@pixi/devtools` уже сериализует полное дерево сцены с позициями, tint, visible. Писать своё — дублирование.
   - *Trade-off:* Зависимость от формата данных `@pixi/devtools`. Если формат изменится — сломается.
   - *Reversibility:* Лёгкая. Можно написать собственный сериализатор и подставить через интерфейс `SceneInspector`.

5. **Конфиг в проекте + автогенерация через init** — `agent-view.config.json` хранит runtime, port, launch command, WebGL engine, опциональный verify-маппинг.
   - *Context:* Агент вызывает команды десятки раз за сессию. Без конфига каждый вызов требует `--port 9222 --engine pixi` — лишние токены.
   - *Trade-off:* Ещё один конфиг-файл в проекте.
   - *Reversibility:* Лёгкая. CLI-флаги работают как override.

6. **Агент сам определяет что проверять по git diff** — SKILL.md инструктирует агента анализировать diff и вызывать нужные команды. Опциональный маппинг файл → проверка в конфиге.
   - *Context:* В desktop-приложениях нет прямого маппинга файл → URL (как в Next.js). Агент с доступом к исходникам лучше понимает контекст, чем статический маппинг.
   - *Trade-off:* Агент может ошибиться в определении затронутых областей. Маппинг в конфиге — страховочная сетка.
   - *Reversibility:* Лёгкая. Маппинг можно добавлять инкрементально.

7. **Windows first, расширяемость на macOS/Linux** — MVP работает только на Windows. Архитектура (интерфейсы Transport, RuntimeAdapter, SceneInspector) позволяет расширять без переписывания.
   - *Context:* На Windows все три runtime дают CDP. На macOS/Linux Tauri требует injected bridge — отдельный объём работы.
   - *Trade-off:* macOS/Linux пользователи не могут использовать пакет с Tauri.
   - *Reversibility:* Средняя. Добавление injected bridge — новый модуль, существующий код не меняется.

8. **Session ref IDs** — инкрементный ID, маппинг `ref → backendNodeId` хранится в памяти lazy server. Невалидный ref возвращает ошибку, агент делает повторный `dom`.
   - *Context:* HMR или навигация инвалидирует ref. Persistent ref (хэш от DOM-пути) — усложнение для v2.
   - *Reversibility:* Лёгкая. Можно добавить persistent ref как улучшение.

9. **Один lazy server на все проекты** — различает по CDP-порту. CLI читает конфиг из текущей директории и передаёт параметры в каждом запросе. Сервер stateless относительно конфигов.

10. **`stop` останавливает только lazy server** — приложение продолжает работать. Разработчик управляет dev-сервером сам.

11. **Плоский текст как формат вывода** — минимум токенов, LLM отлично понимает текстовый accessibility tree. Исключение: `discover` возвращает JSON (список окон с id для программного парсинга).

12. **Без автотестов на старте** — ручная верификация на реальном проекте `D:\web-projects\web-client` (Electron + Vue 3). Тесты добавляются после стабилизации API.

## Risks & Dependencies

| Risk / Dependency | Impact | Likelihood | Mitigation |
|-------------------|--------|------------|------------|
| WebView2 CDP на Windows работает нестабильно с конкретной версией Tauri | Высокий — Tauri adapter не работает | Низкая | Proof-of-concept (Haprog/playwright-cdp) подтверждает работоспособность. Тестировать на целевой версии Tauri v2 |
| `@pixi/devtools` меняет формат `window.__PIXI_DEVTOOLS__` | Средний — Scene Inspector ломается | Низкая | Абстракция через интерфейс SceneInspector. Фоллбэк на прямое чтение `app.stage` |
| Orphaned lazy server процессы | Низкий — утечка ресурсов | Средняя | Auto-shutdown по таймауту (5 мин). PID-файл для обнаружения и kill. Команда `agent-view stop` |
| Большой scene graph SCADA (сотни объектов) — переполнение контекстного окна | Высокий — агент теряет контекст | Средняя | Фильтрация (`--filter`), ограничение глубины (`--depth`), компактный формат по умолчанию, `--diff` режим |
| Несколько приложений на одном CDP-порту | Средний — подключение к не тому приложению | Средняя | Конфиг привязывает проект к конкретному порту. `discover` показывает что найдено |
| Именование PixiJS-объектов в SCADA — объекты без `name`/`label` | Высокий — агент не может адресовать объекты | Средняя | Prerequisite в README: добавить осмысленные name к ключевым объектам. Фоллбэк на идентификацию по type + position |
| CDP `Page.captureScreenshot` не захватывает WebGL canvas | Средний — пустой canvas на скриншоте | Низкая | Проверить в PoC. Fallback: `canvas.toDataURL()` через `Runtime.evaluate` |

## Out of Scope

- **macOS / Linux поддержка Tauri** — отложено до v2. Требует injected bridge как альтернативный transport (WKWebView и WebKitGTK не поддерживают CDP). Архитектура готова к расширению через интерфейс `Transport`.
- **CesiumJS адаптер** — отложено до v2. Нет зрелого devtools-пакета, аналогичного `@pixi/devtools`. Потребуется собственный сериализатор через `viewer.entities` API.
- **Three.js / Babylon.js / Konva.js адаптеры** — будущие расширения через интерфейс `SceneInspector`.
- **E2E тест генерация** — генерация Playwright `.spec.ts` файлов из агентных сценариев.
- **Visual regression testing** — эталонные скриншоты, pixel-diff, perceptual-diff.
- **Верификация UI по ТЗ/PRD** — мультимодальный pipeline (текст спеки + скриншот → вердикт).
- **CI/headless режим** — запуск в пайплайнах без GUI.
- **MCP-сервер** — альтернативный интерфейс для агентов, не использующих Claude Code (Cursor, OpenCode). Для MVP только Claude Code skill.
- **Скриптовый режим** — возможность писать JS-скрипты как в dev-browser, помимо CLI-команд.
- **`--fullpage` скриншот** — для desktop-приложений неоднозначен, отложено.
- **Автотесты** — добавляются после стабилизации API.

## Pilot Validation

### Основной тестовый проект: `web-client` (Electron + Vue 3)

**Путь:** `D:\web-projects\web-client`
**Запуск:** `npm run dev`
**Scope:** DOM + screenshot + multiwindow + interaction

Сценарии валидации описываются отдельно. Включают тестирование multiwindow и multi-monitor.

### Пилот 2: SCADA (Tauri + SolidJS + PixiJS)

Добавляется на итерации 3 (WebGL). Подготовка:
- [ ] Установить `@pixi/devtools`, вызвать `initDevtools({ app })` в dev-режиме
- [ ] Добавить `additionalBrowserArgs: "--remote-debugging-port=9222"` в `tauri.conf.json`
- [ ] Добавить осмысленные `name`/`label` к ключевым PixiJS-объектам

## Further Notes

### Вдохновение и референсы
- [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser) — архитектура stateful server + агентные скрипты
- [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) — diff snapshot, CLI-подход
- [garrytan/gstack](https://github.com/garrytan/gstack) — /qa команда с автоматическим определением затронутых UI-областей по git diff
- [Haprog/playwright-cdp](https://github.com/Haprog/playwright-cdp) — proof-of-concept Playwright + Tauri v2 через CDP на Windows
- [@pixi/devtools](https://pixijs.io/devtools/docs/guide/installation/) — PixiJS scene graph inspection

### Config формат (agent-view.config.json)

```json
{
  "runtime": "electron",
  "port": 9222,
  "launch": "npm run dev",
  "webgl": {
    "engine": "pixi"
  },
  "verify": {
    "src/components/Pump.tsx": {
      "steps": ["scene --filter 'насос'"]
    }
  }
}
```

### CLI Reference (MVP)

```
agent-view init                        # Автогенерация конфига
agent-view launch                      # Запуск приложения из конфига
agent-view discover                    # Обнаружение runtime и окон (JSON)
agent-view dom [--window] [--filter] [--depth]          # DOM accessibility tree (текст)
agent-view scene [--window] [--filter] [--depth] [--verbose] [--diff]  # WebGL scene graph (текст)
agent-view snap [--window] [--filter] [--depth]         # DOM + scene вместе (текст)
agent-view screenshot [--window]                         # Скриншот
agent-view click <ref|--pos x,y>       # Клик по элементу
agent-view fill <ref> <value>          # Ввод текста
agent-view stop                        # Остановить lazy server
```

### Prerequisite для разработчика (README)

**PixiJS-приложения:**
```bash
npm install @pixi/devtools
```
```typescript
import { initDevtools } from '@pixi/devtools'
if (import.meta.env.DEV) {
  initDevtools({ app })
}
```

**Tauri v2 (Windows):**
```json
// tauri.conf.json
{
  "app": {
    "windows": [{
      "additionalBrowserArgs": "--remote-debugging-port=9222"
    }]
  }
}
```

**Electron:**
```typescript
// main.ts
if (process.env.NODE_ENV === 'development') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}
```

### Roadmap

- **v1 (MVP):** Browser + Electron + Tauri (Windows), PixiJS scene graph, CLI-команды, lazy server, конфиг + init
- **v2:** CesiumJS адаптер, macOS/Linux через injected bridge, MCP-сервер
- **v3:** Visual regression (эталонные скриншоты), e2e тест генерация, верификация по ТЗ
