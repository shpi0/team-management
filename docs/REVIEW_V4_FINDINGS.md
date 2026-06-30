# Review v4 findings

Дата: 2026-06-30.

Контекст: после исправлений по `docs/REVIEW_V3_FINDINGS.md` выполнен новый полный цикл ревью спецификации, реализации и автотестов.

## Summary

Исправления V3 в целом применены корректно:

- rename роли теперь мигрирует `people[].role` и переносит явный цвет;
- duplicate rename роли отклоняется;
- `TC-15.3` усилен проверками reorder → undo → redo → reload;
- добавлен блок TS-16 для lifecycle `roleColors`;
- лимиты тегов добавлены;
- полный прогон раннера проходит: `94/94 passed`.

Новые находки связаны не с happy path UI, а с обходными состояниями через импорт/localStorage и с тем, что live-preview цвета роли мутирует `state` без commit/persist/history.

## Checks performed

- `node docs\run-tests.js` - `94/94 passed`.
- `node --check docs\run-tests.js` - OK.
- Проверка синтаксиса встроенного script из `index.html` через `new Function` - OK.
- Статический поиск внешних сетевых вызовов - внешних зависимостей не обнаружено.
- `git status --short` - clean.
- Ручная Playwright-проверка rename локации: миграция `people[].location` и undo работают.
- Ручная Playwright-проверка импортного/LS-состояния с дублями `roles`/`locations` - выявлен V4-F1.
- Ручная Playwright-проверка color live-preview без `change` - выявлен V4-F2.

## Findings

### V4-F1 (P1): импорт/localStorage допускает дубли ролей и локаций, хотя UI их запрещает

**Где:**

- `index.html:333` - `normalizeDoc(input)`.
- `index.html:335` - `roles` берутся через `src.roles.filter(...)` без дедупликации.
- `index.html:336` - `locations` берутся через `src.locations.filter(...)` без дедупликации.
- `index.html:904` - UI rename для locations уже запрещает дубли.
- `index.html:919` - UI rename для roles уже запрещает дубли.

**Что происходит:**

Через `localStorage` или импорт можно загрузить состояние, которое UI больше не позволяет создать:

```js
roles: ["Backend", "Backend", "QA"]
locations: ["Moscow", "Moscow"]
```

После загрузки дубли остаются в `state.roles`/`state.locations`, а фильтры получают повторяющиеся option:

```json
{
  "roles": ["Backend", "Backend", "QA"],
  "locations": ["Moscow", "Moscow"],
  "roleOptions": ["Все роли", "Backend", "Backend", "QA"],
  "locOptions": ["Все локации", "Moscow", "Moscow"]
}
```

**Почему это риск:**

Проект уже принял продуктовую политику "дубли справочников запрещены". Но нормализатор оставляет обходной путь для невалидного состояния:

- фильтры показывают повторяющиеся значения;
- справочник ролей становится неоднозначным;
- fallback-цвет роли зависит от `state.roles.indexOf(role)`, то есть второй дубль практически неразличим;
- `roleColors` хранится по имени роли, поэтому две одинаковые роли не могут иметь разные явные цвета;
- дальнейшие rename/delete/move в UI работают поверх уже неоднозначного состояния.

**Рекомендация:**

Дедуплицировать `roles` и `locations` в `normalizeDoc()` с сохранением первого вхождения:

```js
const uniqStrings = arr => [...new Set(
  (Array.isArray(arr) ? arr : [])
    .filter(v => typeof v === "string")
    .map(v => v.trim())
    .filter(Boolean)
)];
```

Применить для `roles` и `locations`.

Отдельно решить, нужно ли чистить `roleColors` от ключей, которых нет в `roles`. Текущая модель допускает "несправочные" роли у людей после удаления роли, поэтому удалять такие ключи автоматически может быть спорно. Минимально достаточно убрать дубли из самих справочников.

**Тесты:**

Добавить кейс в TS-2 или TS-16:

- загрузить через LS/импорт документ с дублями `roles` и `locations`;
- проверить, что после `normalizeDoc()` справочники уникальны;
- проверить, что фильтры не содержат повторяющихся options;
- проверить отсутствие `pageerror`.

### V4-F2 (P2): live-preview цвета роли мутирует `state` без commit/persist/history

**Где:**

- `index.html:913` - обработчик `[data-rolecolor]`.
- `index.html:915` - `apply()` меняет `state.roleColors[r]`.
- `index.html:916` - `oninput` вызывает `apply(); render();` без `commit()`.
- `index.html:917` - `onchange` вызывает `apply(); commit();`.

**Что происходит:**

`input`-событие color picker уже меняет `state`, но не пишет localStorage и не создает history-точку. Ручная проверка:

```json
{
  "before": "rgb(59, 130, 246)",
  "beforeState": "#3b82f6",
  "afterInputOnly": "rgb(255, 0, 0)",
  "stateAfterInput": "#ff0000",
  "lsAfterInputRaw": false,
  "lsAfterUnrelatedCommit": "#ff0000",
  "lsAfterUndo": "#3b82f6"
}
```

То есть после одного `input` пользователь видит новый цвет, `state` уже изменен, но LS/history еще нет. Следующий unrelated `commit()` (например, добавить команду) сохраняет этот цвет вместе с другой операцией. Undo затем откатывает обе вещи как одно действие.

**Почему это риск:**

Поведение "предпросмотр без истории" сейчас на самом деле не является чистым preview. Это реальная in-memory мутация документа:

- можно случайно сохранить цвет вместе с другой операцией;
- undo-гранулярность становится неочевидной;
- если пользователь закроет модалку/Escape после input без change, на экране цвет уже применен, но после reload он может исчезнуть;
- тест `TC-15.5` проверяет change-path, но не input-only path.

**Рекомендация:**

Сделать preview без мутации `state`.

Варианты:

1. На `input` менять только DOM текущих `.grade` для соответствующей роли, а `state.roleColors` менять только на `change`.
2. Держать временный `ui.previewRoleColors` и учитывать его в render только пока открыта модалка.
3. Упростить: убрать live-preview и перейти на `change` only.

Минимально безопасный вариант - `change` only. Если live-preview нужен, лучше не использовать `state` как preview-хранилище.

**Тесты:**

Добавить кейс:

- открыть settings;
- отправить только `input` на `[data-rolecolor]`, не отправляя `change`;
- закрыть модалку/Escape;
- проверить выбранную семантику:
  - если это preview, то `state`/LS/history не изменились и после render/reload цвет прежний;
  - если это реальное изменение, тогда оно должно быть persist/history-consistent.

### V4-F3 (P2): миграция локаций реализована, но почти не покрыта автотестами

**Где:**

- `index.html:904` - общий обработчик `[data-edit]` для locations.
- `index.html:910` - при `key === "locations"` мигрирует `people[].location`.
- `docs/TEST_PLAN.md:251` - `TC-11.5` описывает добавить/переименовать/удалить локацию, но в раннере фактически покрыто не все.

**Что проверено вручную:**

Rename первой локации:

- обновляет `state.locations`;
- мигрирует всех сотрудников со старой локацией на новую;
- создает undo-точку;
- undo возвращает старое имя локации и значения `people[].location`.

**Почему это риск:**

Изменение поведения локаций было сделано вместе с исправлением ролей. Оно логично и соответствует обновленной SPEC, но не имеет такого же целевого покрытия, как TS-16 для ролей.

**Рекомендация:**

Добавить тесты для locations:

- rename локации мигрирует `people[].location`;
- duplicate rename локации отклоняется;
- undo после rename локации возвращает справочник и сотрудников;
- delete локации не меняет существующих людей, если это ожидаемая продуктовая семантика.

### V4-F4 (P3): `TEST_REPORT.md` устарел после успешного прогона 94/94

**Где:**

- `docs/TEST_REPORT.md:153` - блок V3 все еще говорит `pending re-run`.
- `docs/TEST_REPORT.md:169` - инструкция "Как повторить прогон" также упоминает pending re-run для новых кейсов.

**Что происходит:**

Фактический прогон уже подтвержден:

```text
P0: 30 pass / 0 fail
P1: 50 pass / 0 fail
P2: 14 pass / 0 fail
TOTAL: 94/94 passed
```

Но отчет все еще частично говорит, что новые кейсы pending.

**Рекомендация:**

Обновить `docs/TEST_REPORT.md`:

- заменить pending re-run на подтвержденный прогон `94/94`;
- добавить текущую разбивку по приоритетам;
- зафиксировать PNG outcome: `download=false printFallback=true`, если он остается таким же.

## Suggested fix order

1. Дедуплицировать `roles`/`locations` в `normalizeDoc()` и добавить тест импорта/LS с дублями справочников.
2. Решить семантику color live-preview и убрать мутацию `state` без history/persist либо сделать ее полноценным commit.
3. Добавить автотесты для rename/duplicate/undo lifecycle локаций.
4. Обновить `docs/TEST_REPORT.md` под фактический прогон `94/94`.
