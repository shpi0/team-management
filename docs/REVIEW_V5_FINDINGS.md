# Review v5 findings

Дата: 2026-06-30.

Контекст: после исправлений по `docs/REVIEW_V4_FINDINGS.md` выполнен очередной полный цикл ревью. Файлы приложения и тестов в ходе ревью не менялись.

## Summary

Исправления V4 в целом применены корректно:

- exact-дубли `roles`/`locations` из LS/импорта дедуплицируются;
- color picker роли переведен на change-only, `input` больше не мутирует `state`;
- миграция локаций покрыта тестами;
- полный раннер проходит: `98/98 passed`.

Новые находки низкого/среднего риска: нормализация справочников не trim-ит значения перед дедупликацией, а часть документации не синхронизирована с фактическим успешным прогоном и новой semantics color picker.

## Checks performed

- `node docs\run-tests.js` - `98/98 passed`.
- `node --check docs\run-tests.js` - OK.
- Проверка синтаксиса встроенного script из `index.html` через `new Function` - OK.
- Статический поиск внешних сетевых вызовов - внешних зависимостей не обнаружено.
- `git status --short` - clean.
- Ручная Playwright-проверка V4-F1 exact-дублей - закрыто.
- Ручная Playwright-проверка V4-F2 color picker input-only - закрыто.
- Ручная Playwright-проверка whitespace-дублей справочников - выявлен V5-F1.

## Findings

### V5-F1 (P2): `uniqStrings` не trim-ит значения перед дедупликацией справочников

**Где:**

- `index.html:333` - `uniqStrings`.
- `index.html:337` - `roles = uniqStrings(src.roles)`.
- `index.html:338` - `locations = uniqStrings(src.locations)`.
- `docs/run-tests.js:344` - `TC-2.10` покрывает exact-дубли, но не whitespace-дубли.

**Что происходит:**

`uniqStrings` отбрасывает whitespace-only строки через `v.trim() !== ""`, но в `Set` кладет исходное значение без trim:

```js
const uniqStrings = (arr)=> [...new Set(
  (Array.isArray(arr)?arr:[])
    .filter(v=>typeof v==="string" && v.trim()!=="")
)];
```

Ручная проверка через `localStorage`:

```js
roles: ["Backend", " Backend ", "QA", "QA"]
locations: ["Moscow", " Moscow ", "Moscow"]
```

После загрузки:

```json
{
  "roles": ["Backend", " Backend ", "QA", "QA"],
  "locations": ["Moscow", " Moscow ", "Moscow"],
  "roleOpts": ["Все роли", "Backend", " Backend ", "QA"],
  "locOpts": ["Все локации", "Moscow", " Moscow "]
}
```

Exact-дубли в UI options уже скрываются частично за счет `<select>` rendering/option text, но в `state` остаются значения с пробелами как отдельные справочные элементы.

**Почему это риск:**

UI rename/add использует trim-семантику, поэтому через UI нельзя осознанно создать `"Backend"` и `" Backend "` как разные роли. Импорт/localStorage опять может создать состояние, отличающееся от UI-инвариантов:

- визуально похожие/почти одинаковые options в фильтрах и справочниках;
- неоднозначный fallback-цвет по `state.roles.indexOf(role)`;
- `roleColors` по имени роли не совпадает для `"Backend"` и `" Backend "`;
- дальнейшие rename/delete/move работают поверх значений, которые пользователь воспринимает как дубли.

**Рекомендация:**

Trim до дедупликации:

```js
const uniqStrings = (arr)=> [...new Set(
  (Array.isArray(arr)?arr:[])
    .filter(v=>typeof v==="string")
    .map(v=>v.trim())
    .filter(Boolean)
)];
```

Если нужно сохранить пробелы внутри имени, это сохранит их; уберутся только края.

**Тесты:**

Расширить `TC-2.10`:

- `roles: ["Backend", " Backend ", "QA", "QA"]`;
- `locations: ["Moscow", " Moscow ", "Moscow"]`;
- ожидать `roles === ["Backend", "QA"]`, `locations === ["Moscow"]`;
- проверить уникальные option в фильтрах и отсутствие `pageerror`.

### V5-F2 (P3): `TEST_REPORT.md` всё еще содержит pending для уже подтвержденного `98/98`

**Где:**

- `docs/TEST_REPORT.md:25` - верхний блок говорит, что новые V4-кейсы pending re-run.
- `docs/TEST_REPORT.md:175` - раздел V4 говорит `94 подтверждены, 4 pending re-run`.
- `docs/TEST_REPORT.md:189` - "Как повторить прогон" также говорит pending для TC-2.10, TC-16.7–16.9.

**Фактический результат ревью:**

```text
P0: 30 pass / 0 fail
P1: 53 pass / 0 fail
P2: 15 pass / 0 fail
TOTAL: 98/98 passed
```

**Почему это риск:**

Отчет противоречит фактическому состоянию и может ввести следующего разработчика/агента в заблуждение: он будет считать V4-кейсы еще не подтвержденными, хотя они уже прошли.

**Рекомендация:**

Обновить `docs/TEST_REPORT.md`:

- заменить pending re-run для V4 на подтвержденный `98/98`;
- добавить актуальную разбивку по приоритетам: P0 `30`, P1 `53`, P2 `15`;
- зафиксировать текущий PNG outcome: `download=false printFallback=true`, если он остается ожидаемым для headless Chromium.

### V5-F3 (P3): `TEST_PLAN.md` местами устарел относительно новой разметки и semantics color picker

**Где:**

- `docs/TEST_PLAN.md:250` - `TC-11.2` описывает переименование роли через `[data-edit]`, но роли сейчас используют `[data-roleedit]`.
- `docs/TEST_PLAN.md:306` - `TC-15.5` все еще говорит, что `input` у `[data-rolecolor]` - live-preview без истории.
- `docs/TEST_PLAN.md:319` - `TC-16.7` уже описывает актуальную semantics change-only.
- `docs/SPEC.md:323` - SPEC также описывает актуальную semantics: цвет применяется только на `change`.

**Почему это риск:**

Тестовый раннер уже использует правильные селекторы и проходит. Но ручной тест-план как документация для разработчика/агента содержит старые инструкции:

- можно ошибочно писать новые тесты на старый selector `[data-edit]` для роли;
- можно ошибочно ожидать live-preview от color picker, хотя он намеренно удален по V4-F2.

**Рекомендация:**

Обновить `docs/TEST_PLAN.md`:

- `TC-11.2`: заменить `[data-edit]` на `[data-roleedit]`;
- `TC-15.5`: заменить описание `input` live-preview на change-only или сослаться на `TC-16.7`;
- проверить DOM reference table: для roles явно указывать `[data-roleedit]`, для locations - `[data-edit]`.

## Suggested fix order

1. Исправить `uniqStrings`: trim до `Set`; расширить `TC-2.10` whitespace-дублями.
2. Обновить `docs/TEST_REPORT.md` под фактический прогон `98/98`.
3. Обновить устаревшие строки `docs/TEST_PLAN.md` по role rename selector и color picker semantics.
