/* Team Balancer — autonomous Playwright test runner.
 * Covers docs/TEST_PLAN.md (TS-1 .. TS-14). */
const { chromium } = require('playwright');

const URL = 'http://localhost:8000/index.html';
const LS = 'team-balancer-v1';

// ---------- tiny test framework ----------
const results = [];
let curErrors = [];      // pageerror per test
async function T(id, prio, name, fn) {
  curErrors = [];
  const rec = { id, prio, name, status: 'pass', msg: '' };
  try {
    await fn();
    if (curErrors.length) { rec.status = 'fail'; rec.msg = 'pageerror: ' + curErrors.join(' | '); }
  } catch (e) {
    rec.status = 'fail';
    rec.msg = (e && e.message ? e.message : String(e)).split('\n')[0];
  }
  results.push(rec);
  const tag = rec.status === 'pass' ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${id} (${prio}) ${name}${rec.msg ? '  -- ' + rec.msg : ''}`);
}
function assert(cond, msg) { if (!cond) throw new Error('assert failed: ' + msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`expected ${JSON.stringify(b)} got ${JSON.stringify(a)} :: ${msg}`); }
function near(a, b, eps, msg) { if (Math.abs(a - b) > (eps ?? 0.05)) throw new Error(`expected ~${b} got ${a} :: ${msg}`); }

// ---------- LS helpers ----------
const lsGet = (page) => page.evaluate(k => JSON.parse(localStorage.getItem(k) || 'null'), LS);
const lsSet = (page, fx) => page.evaluate(([k, v]) => localStorage.setItem(k, JSON.stringify(v)), [LS, fx]);
const lsClear = (page) => page.evaluate(k => localStorage.removeItem(k), LS);
async function bootDemo(page) { await page.goto(URL); await lsClear(page); await page.reload(); }
async function bootFixture(page, fx) { await page.goto(URL); await lsSet(page, fx); await page.reload(); }

async function html5Drag(page, chipSel, teamSel) {
  await page.evaluate(({ c, t }) => {
    const src = document.querySelector(c), tgt = document.querySelector(t), dt = new DataTransfer();
    const f = (el, ty) => el.dispatchEvent(new DragEvent(ty, { bubbles: true, cancelable: true, dataTransfer: dt }));
    f(src, 'dragstart'); f(tgt, 'dragover'); f(tgt, 'drop'); f(src, 'dragend');
  }, { c: chipSel, t: teamSel });
}

// fixtures
const FX = () => ({
  state: {
    meta: { name: "Test", version: 1 },
    roles: ["Backend", "QA"], locations: ["Москва", "Минск"],
    teams: [{ id: "tA", name: "A", color: "#4f8cff" }, { id: "tB", name: "B", color: "#6ee7b7" }],
    people: [
      { id: "p1", name: "S10", role: "Backend", grade: 10, isContractor: false, location: "Москва", allocations: [{ teamId: "tA", fte: 1 }] },
      { id: "p2", name: "S8", role: "QA", grade: 8, isContractor: false, location: "Москва", allocations: [{ teamId: "tA", fte: 0.5 }] },
      { id: "p3", name: "Contr", role: "Backend", grade: null, isContractor: true, location: "Минск", allocations: [{ teamId: "tB", fte: 1 }] }
    ]
  }, snapshots: [], baselineId: null, uidCounter: 1000
});

// fixture for split allocation (p in two teams)
const FX_SPLIT = () => ({
  state: {
    meta: { name: "Split", version: 1 },
    roles: ["Backend"], locations: ["Москва"],
    teams: [{ id: "tA", name: "A", color: "#4f8cff" }, { id: "tB", name: "B", color: "#6ee7b7" }],
    people: [
      { id: "p1", name: "Half", role: "Backend", grade: 10, isContractor: false, location: "Москва", allocations: [{ teamId: "tA", fte: 0.5 }, { teamId: "tB", fte: 0.5 }] }
    ]
  }, snapshots: [], baselineId: null, uidCounter: 1000
});

// fixture with an outlier team (grade)
const FX_OUTLIER = () => ({
  state: {
    meta: { name: "Out", version: 1 },
    roles: ["Backend"], locations: ["Москва"],
    teams: [
      { id: "t1", name: "T1", color: "#4f8cff" },
      { id: "t2", name: "T2", color: "#6ee7b7" },
      { id: "t3", name: "T3", color: "#e0a516" },
      { id: "t4", name: "T4", color: "#a855f7" }
    ],
    people: [
      { id: "p1", name: "a", role: "Backend", grade: 9, isContractor: false, location: "Москва", allocations: [{ teamId: "t1", fte: 1 }] },
      { id: "p2", name: "b", role: "Backend", grade: 9, isContractor: false, location: "Москва", allocations: [{ teamId: "t2", fte: 1 }] },
      { id: "p3", name: "c", role: "Backend", grade: 9, isContractor: false, location: "Москва", allocations: [{ teamId: "t3", fte: 1 }] },
      { id: "p4", name: "d", role: "Backend", grade: 12, isContractor: false, location: "Москва", allocations: [{ teamId: "t4", fte: 1 }] }
    ]
  }, snapshots: [], baselineId: null, uidCounter: 1000
});

// смешанные команды: крупный подрядный FTE не должен искажать сводный средний грейд
// корректно: weight по grade-FTE → (10*1 + 6*1)/2 = 8.0; ошибочно (по полному FTE) → ~9.6
const FX_MIXGRADE = () => ({
  state: {
    meta: { name: "Mix", version: 1 },
    roles: ["Backend"], locations: ["Москва"],
    teams: [
      { id: "tX", name: "X", color: "#4f8cff" },
      { id: "tY", name: "Y", color: "#6ee7b7" }
    ],
    people: [
      { id: "s10", name: "S10", role: "Backend", grade: 10, isContractor: false, location: "Москва", allocations: [{ teamId: "tX", fte: 1 }] },
      { id: "c9", name: "Contr", role: "Backend", grade: null, isContractor: true, location: "Москва", allocations: [{ teamId: "tX", fte: 9 }] },
      { id: "s8", name: "S8y", role: "Backend", grade: 8, isContractor: false, location: "Москва", allocations: [{ teamId: "tY", fte: 1 }] }
    ]
  }, snapshots: [], baselineId: null, uidCounter: 1000
});

// структурно некорректные документы для проверки normalizeDoc при импорте
const FX_BADSCHEMA = {
  state: {
    // нет meta/roles/locations; people с разной «грязью»
    teams: [
      { id: "ok1", name: "Good", color: "#4f8cff" },
      { id: "bad id!", name: "Renamed", color: "not-a-color" }   // небезопасный id + битый цвет
    ],
    people: [
      { id: "pp1", name: "Valid", role: "Backend", grade: 99, isContractor: false, location: "М", allocations: [{ teamId: "ok1", fte: 1 }] }, // grade клампится до 12
      { id: "pp2", name: "ContrWithGrade", grade: 11, isContractor: true, allocations: [{ teamId: "ok1", fte: "0.5" }] }, // grade→null, fte строкой
      { id: "pp3", name: "GhostTeam", isContractor: false, grade: 8, allocations: [{ teamId: "does-not-exist", fte: 1 }] }, // аллокация на несуществующую команду → отбрасывается
      { id: "pp4", name: "NoAlloc", grade: 9, isContractor: false, allocations: [{ teamId: "ok1", fte: 0 }] }, // fte=0 → нет аллокаций → человек отброшен
      { id: "pp5", name: "BadAlloc", grade: 7, isContractor: false, allocations: "nope" } // allocations не массив → отброшен
    ]
  }, snapshots: "garbage", baselineId: "nope"
};

// дубли id (V2-F1): две команды/два человека/два снимка с одинаковым безопасным id
const FX_DUPIDS = {
  state: {
    meta: { name: "Dup", version: 1 }, roles: ["Backend"], locations: ["М"],
    teams: [
      { id: "tA", name: "A1", color: "#4f8cff" },
      { id: "tA", name: "A2", color: "#6ee7b7" }            // дубликат team id
    ],
    people: [
      { id: "px", name: "One", role: "Backend", grade: 9, isContractor: false, location: "М", allocations: [{ teamId: "tA", fte: 1 }] },
      { id: "px", name: "Two", role: "Backend", grade: 10, isContractor: false, location: "М", allocations: [{ teamId: "tA", fte: 1 }] } // дубликат person id
    ]
  },
  snapshots: [
    { id: "sX", name: "S1", createdAt: "2026-01-01 00:00", doc: { meta: {}, roles: [], locations: [], teams: [], people: [] } },
    { id: "sX", name: "S2", createdAt: "2026-01-02 00:00", doc: { meta: {}, roles: [], locations: [], teams: [], people: [] } } // дубликат snapshot id
  ], baselineId: null
};

// round-trip полного пакета приложения (безопасные id): snapshot идентичен state, baseline выбран.
// После импорта и включения compare никто не должен подсветиться как moved-in (V2-F2 — реальный кейс).
const FX_ROUNDTRIP = () => {
  const doc = {
    meta: { name: "RT", version: 1 }, roles: ["Backend"], locations: ["М"],
    teams: [{ id: "tA", name: "A", color: "#4f8cff" }, { id: "tB", name: "B", color: "#6ee7b7" }],
    people: [
      { id: "p1", name: "Stay1", role: "Backend", grade: 10, isContractor: false, location: "М", allocations: [{ teamId: "tA", fte: 1 }] },
      { id: "p2", name: "Stay2", role: "Backend", grade: 9, isContractor: false, location: "М", allocations: [{ teamId: "tB", fte: 1 }] }
    ]
  };
  const cp = () => JSON.parse(JSON.stringify(doc));
  return { state: cp(), snapshots: [{ id: "s1", name: "Base", createdAt: "2026-01-01 00:00", doc: cp() }], baselineId: "s1", uidCounter: 2000 };
};

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', e => curErrors.push(e.message));
  page.on('dialog', d => d.accept()); // default accept; overridden per-test via flag
  let dialogMode = 'accept';
  page.removeAllListeners('dialog');
  page.on('dialog', d => { dialogMode === 'dismiss' ? d.dismiss() : d.accept(); });

  const count = (sel) => page.locator(sel).count();

  // ============ TS-1 load & render ============
  await T('TC-1.1', 'P0', 'Чистый старт: 4 команды, 15 карточек', async () => {
    await bootDemo(page);
    eq(await count('.team'), 4, '4 teams');
    // 15 people but Дмитрий has 2 allocs, Мария 2 allocs => chips = 17
    const chips = await count('.chip');
    assert(chips === 17, '17 chips expected (15 people, 2 split into 2), got ' + chips);
    assert(await count('#analyticsBody .stat') >= 5, 'analytics rendered');
  });
  await T('TC-1.2', 'P0', 'Группировка по ролям', async () => {
    await bootDemo(page);
    const t0 = page.locator('.team').first();
    assert(await t0.locator('.role-group').count() >= 1, 'role groups exist');
    assert(await t0.locator('.role-h').count() >= 1, 'role headers exist');
  });
  await T('TC-1.3', 'P1', 'Пустая команда', async () => {
    const fx = FX(); fx.state.teams.push({ id: "tEmpty", name: "Empty", color: "#e5484d" });
    await bootFixture(page, fx);
    const empty = page.locator('.team[data-team-id="tEmpty"]');
    eq(await empty.locator('.empty-team').count(), 1, 'empty-team block');
    eq(await empty.locator('.metric .mv').first().innerText(), '—', 'grade dash'.replace('grade', 'grade'));
  });
  await T('TC-1.4', 'P1', 'Аналитика присутствует', async () => {
    await bootDemo(page);
    eq(await count('#analyticsBody .stat'), 5, '5 stat cards');
    const hint = await page.locator('#anHint').innerText();
    assert(/команд/.test(hint) && /человек/.test(hint), 'anHint text: ' + hint);
  });
  await T('TC-1.5', 'P2', 'Бейджи подрядчика/штата', async () => {
    await bootFixture(page, FX());
    const contr = page.locator('.chip.contractor').first();
    eq(await contr.count(), 1, 'contractor chip exists');
    eq((await contr.locator('.grade').innerText()).trim(), 'ПД', 'ПД badge');
    const staff = page.locator('.chip:not(.contractor)').first();
    assert(/^\d+$/.test((await staff.locator('.grade').innerText()).trim()), 'staff grade numeric');
  });

  // ============ TS-2 persistence ============
  await T('TC-2.1', 'P0', 'Автосейв в LS при переименовании команды', async () => {
    await bootFixture(page, FX());
    const inp = page.locator('.team[data-team-id="tA"] [data-rename]');
    await inp.fill('Renamed A'); await inp.blur();
    await page.waitForTimeout(100);
    const ls = await lsGet(page);
    assert(ls.state.teams.find(t => t.id === 'tA').name === 'Renamed A', 'name persisted');
  });
  await T('TC-2.2', 'P0', 'Сохранение между перезагрузками', async () => {
    await bootFixture(page, FX());
    await page.locator('#addPerson').click();
    await page.locator('#m_name').fill('Persist Me');
    await page.locator('#m_save').click();
    await page.waitForTimeout(100);
    await page.reload();
    assert((await page.locator('.chip .name', { hasText: 'Persist Me' }).count()) >= 1, 'person survived reload');
  });
  await T('TC-2.3', 'P0', 'Экспорт JSON (download)', async () => {
    await bootFixture(page, FX());
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#saveBtn').click()
    ]);
    const fname = dl.suggestedFilename();
    assert(fname.endsWith('.json'), 'json filename: ' + fname);
    const path = await dl.path();
    const data = JSON.parse(require('fs').readFileSync(path, 'utf8'));
    assert(data.state && data.state.teams && data.state.people, 'has state.teams/people');
  });
  await T('TC-2.4', 'P0', 'Импорт полного объекта', async () => {
    await bootDemo(page);
    const fx = FX();
    const fs = require('fs'), os = require('os'), p = require('path');
    const fp = p.join(os.tmpdir(), 'import-full.json');
    fs.writeFileSync(fp, JSON.stringify({ state: fx.state, snapshots: [], baselineId: null, version: 1 }));
    await page.locator('#fileInput').setInputFiles(fp);
    await page.waitForTimeout(200);
    eq(await count('.team'), 2, 'imported 2 teams');
    assert((await page.locator('#toastRoot .toast').innerText()).includes('загружен'), 'toast loaded');
  });
  await T('TC-2.5', 'P1', 'Импорт «голого» документа', async () => {
    await bootDemo(page);
    const fx = FX();
    const fs = require('fs'), os = require('os'), p = require('path');
    const fp = p.join(os.tmpdir(), 'import-bare.json');
    fs.writeFileSync(fp, JSON.stringify(fx.state)); // bare {teams,people,...}
    await page.locator('#fileInput').setInputFiles(fp);
    await page.waitForTimeout(200);
    eq(await count('.team'), 2, 'bare import 2 teams');
  });
  await T('TC-2.6', 'P1', 'Импорт битого JSON', async () => {
    await bootFixture(page, FX());
    const before = await count('.team');
    const fs = require('fs'), os = require('os'), p = require('path');
    const fp = p.join(os.tmpdir(), 'broken.json');
    fs.writeFileSync(fp, '{ this is not json ');
    await page.locator('#fileInput').setInputFiles(fp);
    await page.waitForTimeout(200);
    assert((await page.locator('#toastRoot .toast').innerText()).includes('Не удалось'), 'error toast');
    eq(await count('.team'), before, 'state intact');
  });
  await T('TC-2.8', 'P1', 'Импорт структурно некорректного документа нормализуется', async () => {
    await bootFixture(page, FX());
    const fs = require('fs'), os = require('os'), p = require('path');
    const fp = p.join(os.tmpdir(), 'badschema.json');
    fs.writeFileSync(fp, JSON.stringify(FX_BADSCHEMA));
    await page.locator('#fileInput').setInputFiles(fp);
    await page.waitForTimeout(200);
    const st = (await lsGet(page)).state;
    // справочники-обязательны существуют
    assert(Array.isArray(st.roles) && Array.isArray(st.locations) && Array.isArray(st.teams) && Array.isArray(st.people), 'arrays present');
    eq(st.teams.length, 2, 'two teams kept');
    // небезопасный id перегенерирован, цвет починен
    const renamed = st.teams.find(t => t.name === 'Renamed');
    assert(renamed && /^[A-Za-z0-9_-]+$/.test(renamed.id), 'unsafe id regenerated');
    assert(/^#[0-9a-fA-F]{6}$/.test(renamed.color), 'bad color defaulted');
    // люди: pp1 (grade клампится до 12), pp2 (contractor grade→null) остаются; pp3/pp4/pp5 отброшены
    const names = st.people.map(x => x.name);
    assert(names.includes('Valid'), 'valid person kept');
    eq(st.people.find(x => x.name === 'Valid').grade, 12, 'grade clamped to 12');
    const contr = st.people.find(x => x.name === 'ContrWithGrade');
    assert(contr && contr.grade === null, 'contractor grade nulled');
    eq(contr.allocations[0].fte, 0.5, 'string fte parsed');
    assert(!names.includes('GhostTeam'), 'alloc to missing team dropped → person dropped');
    assert(!names.includes('NoAlloc'), 'fte=0 → person dropped');
    assert(!names.includes('BadAlloc'), 'allocations not-array → person dropped');
    // baselineId на несуществующий снимок → null, без падений рендера
    eq((await lsGet(page)).baselineId, null, 'baseline reset');
    eq(curErrors.length, 0, 'no pageerror');
  });
  await T('TC-2.9', 'P1', 'Импорт с дублями id: нормализация делает их уникальными (V2-F1)', async () => {
    await bootFixture(page, FX());
    const fs = require('fs'), os = require('os'), p = require('path');
    const fp = p.join(os.tmpdir(), 'dupids.json');
    fs.writeFileSync(fp, JSON.stringify(FX_DUPIDS));
    await page.locator('#fileInput').setInputFiles(fp);
    await page.waitForTimeout(200);
    const d = await lsGet(page);
    const teamIds = d.state.teams.map(t => t.id);
    eq(new Set(teamIds).size, teamIds.length, 'team ids unique (' + teamIds.join(',') + ')');
    eq(d.state.teams.length, 2, 'both teams kept');
    const personIds = d.state.people.map(x => x.id);
    eq(new Set(personIds).size, personIds.length, 'person ids unique');
    const snapIds = d.snapshots.map(s => s.id);
    eq(new Set(snapIds).size, snapIds.length, 'snapshot ids unique');
    // на доске два разных data-team-id
    eq(await count('.team'), 2, 'two team cards');
    eq(curErrors.length, 0, 'no pageerror');
  });
  await T('TC-2.7', 'P2', 'Имя кластера переживает reload', async () => {
    await bootFixture(page, FX());
    const pn = page.locator('#projName');
    await pn.fill('My Cluster X'); await pn.dispatchEvent('change');
    await page.waitForTimeout(100);
    await page.reload();
    eq(await page.locator('#projName').inputValue(), 'My Cluster X', 'projName persisted');
  });

  // ============ TS-3 CRUD person ============
  await T('TC-3.1', 'P0', 'Создание штатного', async () => {
    await bootFixture(page, FX());
    await page.locator('#addPerson').click();
    await page.locator('#m_name').fill('New Staff');
    await page.locator('#m_grade').fill('10');
    await page.locator('#m_save').click();
    await page.waitForTimeout(100);
    const chip = page.locator('.chip', { has: page.locator('.name', { hasText: 'New Staff' }) }).first();
    eq(await chip.locator('.grade').innerText(), '10', 'grade 10');
  });
  await T('TC-3.2', 'P0', 'Создание подрядчика', async () => {
    await bootFixture(page, FX());
    await page.locator('#addPerson').click();
    await page.locator('#m_name').fill('New Contr');
    await page.locator('#m_status button[data-st="contractor"]').click();
    assert(await page.locator('#m_grade').isDisabled(), 'grade disabled');
    eq(await page.locator('#m_grade').inputValue(), '', 'grade empty');
    await page.locator('#m_save').click();
    await page.waitForTimeout(100);
    const ls = await lsGet(page);
    const np = ls.state.people.find(p => p.name === 'New Contr');
    assert(np && np.grade === null && np.isContractor === true, 'contractor grade null');
  });
  await T('TC-3.3', 'P0', 'Редактирование', async () => {
    await bootFixture(page, FX());
    const chip = page.locator('.chip[data-person-id="p1"]').first();
    await chip.hover();
    await chip.locator('[data-edit]').click({ force: true });
    await page.locator('#m_grade').fill('7');
    await page.locator('#m_loc').selectOption('Минск');
    await page.locator('#m_save').click();
    await page.waitForTimeout(100);
    const c2 = page.locator('.chip[data-person-id="p1"]').first();
    eq(await c2.locator('.grade').innerText(), '7', 'grade updated');
    assert((await c2.locator('.meta').innerText()).includes('Минск'), 'loc updated');
  });
  await T('TC-3.4', 'P0', 'Удаление сотрудника', async () => {
    await bootFixture(page, FX());
    const before = await count('.chip');
    const chip = page.locator('.chip[data-person-id="p1"]').first();
    await chip.hover();
    await chip.locator('[data-edit]').click({ force: true });
    await page.locator('#m_delete').click();
    await page.waitForTimeout(100);
    eq(await count('.chip[data-person-id="p1"]'), 0, 'p1 gone');
    eq(await count('.chip'), before - 1, 'count -1');
  });
  await T('TC-3.5', 'P1', 'Кламп грейда 99→12, 1→7', async () => {
    await bootFixture(page, FX());
    // 99 -> 12
    let chip = page.locator('.chip[data-person-id="p1"]').first();
    await chip.hover(); await chip.locator('[data-edit]').click({ force: true });
    await page.locator('#m_grade').fill('99'); await page.locator('#m_save').click();
    await page.waitForTimeout(80);
    eq((await lsGet(page)).state.people.find(p => p.id === 'p1').grade, 12, 'clamped to 12');
    // 1 -> 7
    chip = page.locator('.chip[data-person-id="p1"]').first();
    await chip.hover(); await chip.locator('[data-edit]').click({ force: true });
    await page.locator('#m_grade').fill('1'); await page.locator('#m_save').click();
    await page.waitForTimeout(80);
    eq((await lsGet(page)).state.people.find(p => p.id === 'p1').grade, 7, 'clamped to 7');
  });
  await T('TC-3.6', 'P1', 'Переключение статуса туда-обратно', async () => {
    await bootFixture(page, FX());
    const chip = page.locator('.chip[data-person-id="p1"]').first();
    await chip.hover(); await chip.locator('[data-edit]').click({ force: true });
    await page.locator('#m_status button[data-st="contractor"]').click();
    await page.locator('#m_status button[data-st="staff"]').click();
    assert(!(await page.locator('#m_grade').isDisabled()), 'grade re-enabled');
    eq(await page.locator('#m_grade').inputValue(), '9', 'grade default 9');
    await page.locator('#m_save').click(); await page.waitForTimeout(80);
    assert((await lsGet(page)).state.people.find(p => p.id === 'p1').grade != null, 'grade not null');
  });
  await T('TC-3.7', 'P1', 'Добавление через футер команды', async () => {
    await bootFixture(page, FX());
    await page.locator('.team[data-team-id="tB"] [data-addhere]').click();
    // alloc row team preselected = tB
    eq(await page.locator('#m_allocs [data-ateam]').first().inputValue(), 'tB', 'preselect tB');
  });
  await T('TC-3.8', 'P1', 'Добавление через [data-addrole]: предвыбор роли', async () => {
    await bootFixture(page, FX());
    const team = page.locator('.team[data-team-id="tA"]');
    const grp = team.locator('.role-group', { has: page.locator('.role-h', { hasText: 'Backend' }) }).first();
    await grp.hover();
    await grp.locator('[data-addrole]').click({ force: true });
    eq(await page.locator('#m_role').inputValue(), 'Backend', 'role preselected Backend');
  });
  await T('TC-3.8b', 'P0', 'Quick-add у роли РЕАЛЬНО сохраняет сотрудника (рег. BUG quickAdd)', async () => {
    await bootFixture(page, FX());
    const before = (await lsGet(page)).state.people.length;
    const team = page.locator('.team[data-team-id="tB"]');
    const grp = team.locator('.role-group', { has: page.locator('.role-h', { hasText: 'Backend' }) }).first();
    await grp.hover();
    await grp.locator('[data-addrole]').click({ force: true });
    await page.locator('#m_name').fill('QuickAdded');
    await page.locator('#m_save').click(); await page.waitForTimeout(100);
    const st = (await lsGet(page)).state;
    eq(st.people.length, before + 1, 'person count +1');
    const added = st.people.find(p => p.name === 'QuickAdded');
    assert(added, 'person persisted');
    eq(added.role, 'Backend', 'role Backend');
    assert(added.allocations.some(a => a.teamId === 'tB'), 'allocated to tB');
    eq(await page.locator('.team[data-team-id="tB"] .chip', { has: page.locator('.name', { hasText: 'QuickAdded' }) }).count(), 1, 'chip on board');
  });
  await T('TC-3.9', 'P1', 'Сохранение без аллокаций → тост, модалка открыта', async () => {
    await bootFixture(page, FX());
    await page.locator('#addPerson').click();
    await page.locator('#m_name').fill('NoAlloc');
    // delete all alloc rows
    let n = await page.locator('#m_allocs [data-adel]').count();
    for (let i = 0; i < n; i++) await page.locator('#m_allocs [data-adel]').first().click();
    await page.locator('#m_save').click();
    await page.waitForTimeout(80);
    assert((await page.locator('#toastRoot .toast').innerText()).includes('аллокаци'), 'toast about alloc');
    assert(await page.locator('#m_save').count() === 1, 'modal still open');
  });
  await T('TC-3.10', 'P2', 'Пустое имя → «Без имени»', async () => {
    await bootFixture(page, FX());
    await page.locator('#addPerson').click();
    await page.locator('#m_name').fill('');
    await page.locator('#m_save').click(); await page.waitForTimeout(80);
    assert((await lsGet(page)).state.people.some(p => p.name === 'Без имени'), 'default name');
  });
  await T('TC-3.11', 'P2', 'Отмена/Esc не сохраняет', async () => {
    await bootFixture(page, FX());
    const before = (await lsGet(page)).state.people.length;
    await page.locator('#addPerson').click();
    await page.locator('#m_name').fill('Ghost');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);
    eq((await lsGet(page)).state.people.length, before, 'no new person');
  });

  // ============ TS-4 CRUD team ============
  await T('TC-4.1', 'P0', 'Добавить команду', async () => {
    await bootFixture(page, FX());
    const before = await count('.team');
    await page.locator('#addTeam').click(); await page.waitForTimeout(80);
    eq(await count('.team'), before + 1, 'team +1');
  });
  await T('TC-4.2', 'P0', 'Переименование инлайн', async () => {
    await bootFixture(page, FX());
    const inp = page.locator('.team[data-team-id="tB"] [data-rename]');
    await inp.fill('B-renamed'); await inp.dispatchEvent('change');
    await page.waitForTimeout(80);
    eq((await lsGet(page)).state.teams.find(t => t.id === 'tB').name, 'B-renamed', 'renamed');
  });
  await T('TC-4.3', 'P0', 'Удаление пустой команды без confirm', async () => {
    const fx = FX(); fx.state.teams.push({ id: "tEmpty", name: "Empty", color: "#e5484d" });
    await bootFixture(page, fx);
    dialogMode = 'accept';
    await page.locator('.team[data-team-id="tEmpty"] [data-delteam]').click();
    await page.waitForTimeout(80);
    eq(await count('.team[data-team-id="tEmpty"]'), 0, 'empty team removed');
  });
  await T('TC-4.4', 'P0', 'Удаление команды с людьми (confirm accept)', async () => {
    // p split A/B: deleting A keeps p in B. p with only A is removed.
    const fx = FX_SPLIT();
    fx.state.people.push({ id: "pOnly", name: "OnlyA", role: "Backend", grade: 9, isContractor: false, location: "Москва", allocations: [{ teamId: "tA", fte: 1 }] });
    await bootFixture(page, fx);
    dialogMode = 'accept';
    await page.locator('.team[data-team-id="tA"] [data-delteam]').click();
    await page.waitForTimeout(80);
    const ls = await lsGet(page);
    eq(ls.state.teams.length, 1, 'A removed');
    assert(ls.state.people.some(p => p.id === 'p1'), 'split person p1 survives in B');
    assert(!ls.state.people.some(p => p.id === 'pOnly'), 'orphan pOnly removed');
  });
  await T('TC-4.5', 'P1', 'Отмена удаления (confirm dismiss)', async () => {
    await bootFixture(page, FX()); // tA has people
    dialogMode = 'dismiss';
    const before = await count('.team');
    await page.locator('.team[data-team-id="tA"] [data-delteam]').click();
    await page.waitForTimeout(80);
    eq(await count('.team'), before, 'nothing changed');
    dialogMode = 'accept';
  });

  // ============ TS-5 DnD ============
  await T('TC-5.1', 'P0', 'Перенос аллокации целиком', async () => {
    await bootFixture(page, FX());
    await html5Drag(page, '.chip[data-person-id="p1"][data-team-id="tA"]', '.team[data-team-id="tB"]');
    await page.waitForTimeout(80);
    eq(await count('.chip[data-person-id="p1"][data-team-id="tB"]'), 1, 'p1 now in B');
    eq(await count('.chip[data-person-id="p1"][data-team-id="tA"]'), 0, 'p1 not in A');
    const ls = await lsGet(page);
    eq(ls.state.people.find(p => p.id === 'p1').allocations[0].teamId, 'tB', 'LS teamId B');
  });
  await T('TC-5.2', 'P0', 'Слияние долей', async () => {
    await bootFixture(page, FX_SPLIT());
    const before = await count('.chip');
    await html5Drag(page, '.chip[data-person-id="p1"][data-team-id="tA"]', '.team[data-team-id="tB"]');
    await page.waitForTimeout(80);
    const ls = await lsGet(page);
    const allocs = ls.state.people.find(p => p.id === 'p1').allocations;
    eq(allocs.length, 1, 'single allocation');
    near(allocs[0].fte, 1.0, 0.001, 'fte merged to 1.0');
    eq(await count('.chip'), before - 1, 'chip count -1');
  });
  await T('TC-5.3', 'P1', 'Перенос в ту же команду — no-op', async () => {
    await bootFixture(page, FX());
    const before = JSON.stringify((await lsGet(page)).state.people);
    await html5Drag(page, '.chip[data-person-id="p1"][data-team-id="tA"]', '.team[data-team-id="tA"]');
    await page.waitForTimeout(80);
    eq(JSON.stringify((await lsGet(page)).state.people), before, 'state unchanged');
  });
  await T('TC-5.4', 'P1', 'Метрики пересчитались после переноса', async () => {
    await bootFixture(page, FX());
    const gradeBefore = await page.locator('.team[data-team-id="tB"] .metric .mv').first().innerText();
    // move p1 (grade10) to B
    await html5Drag(page, '.chip[data-person-id="p1"][data-team-id="tA"]', '.team[data-team-id="tB"]');
    await page.waitForTimeout(80);
    const gradeAfter = await page.locator('.team[data-team-id="tB"] .metric .mv').first().innerText();
    assert(gradeBefore !== gradeAfter, `grade metric changed ${gradeBefore} -> ${gradeAfter}`);
  });
  await T('TC-5.5', 'P1', 'Перенос создаёт undo-точку', async () => {
    await bootFixture(page, FX());
    await html5Drag(page, '.chip[data-person-id="p1"][data-team-id="tA"]', '.team[data-team-id="tB"]');
    await page.waitForTimeout(80);
    assert(!(await page.locator('#undo').isDisabled()), 'undo enabled after move');
  });

  // ============ TS-6 fractional ============
  await T('TC-6.1', 'P0', 'Человек в двух командах = две карточки + бейдж 0.5', async () => {
    await bootFixture(page, FX_SPLIT());
    eq(await count('.chip[data-person-id="p1"]'), 2, 'two chips');
    const fte = await page.locator('.chip[data-person-id="p1"][data-team-id="tA"] .fte').innerText();
    assert(fte.includes('0.5'), 'fte badge 0.5: ' + fte);
  });
  await T('TC-6.2', 'P0', 'Редактирование долей + третья команда', async () => {
    const fx = FX_SPLIT(); fx.state.teams.push({ id: "tC", name: "C", color: "#e0a516" });
    await bootFixture(page, fx);
    const chip = page.locator('.chip[data-person-id="p1"][data-team-id="tA"]');
    await chip.hover(); await chip.locator('[data-edit]').click({ force: true });
    await page.locator('#m_addalloc').click();
    // set new row team to tC
    await page.locator('#m_allocs [data-ateam]').last().selectOption('tC');
    const sumText = await page.locator('#m_allocsum').innerText();
    assert(/FTE/.test(sumText), 'sum shown live: ' + sumText);
    await page.locator('#m_save').click(); await page.waitForTimeout(80);
    eq(await count('.chip[data-person-id="p1"]'), 3, 'now in 3 teams');
  });
  await T('TC-6.3', 'P1', 'Удаление строки аллокации', async () => {
    await bootFixture(page, FX_SPLIT());
    const chip = page.locator('.chip[data-person-id="p1"][data-team-id="tA"]');
    await chip.hover(); await chip.locator('[data-edit]').click({ force: true });
    // remove first alloc row
    await page.locator('#m_allocs [data-adel]').first().click();
    await page.locator('#m_save').click(); await page.waitForTimeout(80);
    eq(await count('.chip[data-person-id="p1"]'), 1, 'one chip left');
  });
  await T('TC-6.4', 'P1', 'fte=0 отбрасывается', async () => {
    await bootFixture(page, FX_SPLIT());
    const chip = page.locator('.chip[data-person-id="p1"][data-team-id="tA"]');
    await chip.hover(); await chip.locator('[data-edit]').click({ force: true });
    await page.locator('#m_allocs [data-afte]').first().fill('0');
    await page.locator('#m_save').click(); await page.waitForTimeout(80);
    const allocs = (await lsGet(page)).state.people.find(p => p.id === 'p1').allocations;
    assert(allocs.every(a => a.fte > 0), 'no zero allocs');
    eq(allocs.length, 1, 'one alloc left');
  });
  await T('TC-6.5', 'P2', 'Полный FTE=1 → бейдж не показан', async () => {
    await bootFixture(page, FX());
    eq(await page.locator('.chip[data-person-id="p1"][data-team-id="tA"] .fte').count(), 0, 'no fte badge at 1.0');
  });

  // ============ TS-7 metrics ============
  await T('TC-7.1', 'P0', 'Средний грейд взвешен по FTE (9.3)', async () => {
    await bootFixture(page, FX()); // team A: g10*1 + g8*0.5 => 18/1.5=9.33
    const mv = await page.locator('.team[data-team-id="tA"] .metric .mv').first().innerText();
    assert(mv.trim().startsWith('9.3'), 'avg grade 9.3, got ' + mv);
  });
  await T('TC-7.2', 'P0', 'Подрядчик исключён из грейда, учтён в доле', async () => {
    const fx = {
      state: {
        meta: { name: "x", version: 1 }, roles: ["Backend"], locations: ["Москва"],
        teams: [{ id: "tA", name: "A", color: "#4f8cff" }, { id: "tB", name: "B", color: "#6ee7b7" }],
        people: [
          { id: "p1", name: "s", role: "Backend", grade: 10, isContractor: false, location: "Москва", allocations: [{ teamId: "tA", fte: 1 }] },
          { id: "p2", name: "c", role: "Backend", grade: null, isContractor: true, location: "Москва", allocations: [{ teamId: "tA", fte: 1 }] }
        ]
      }, snapshots: [], baselineId: null, uidCounter: 1000
    };
    await bootFixture(page, fx);
    const team = page.locator('.team[data-team-id="tA"]');
    eq((await team.locator('.metric').nth(0).locator('.mv').innerText()).trim().split('\n')[0].trim(), '10.0', 'avg grade 10.0');
    assert((await team.locator('.metric').nth(1).locator('.mv').innerText()).includes('50%'), 'contr 50%');
  });
  await T('TC-7.3', 'P0', 'Флаг выброса по грейду (цвет точки)', async () => {
    await bootFixture(page, FX_OUTLIER());
    const colorOf = async (tid) => page.locator(`.team[data-team-id="${tid}"] .metric .flagdot`).first().evaluate(el => getComputedStyle(el).backgroundColor);
    const c4 = await colorOf('t4'); // outlier grade 12
    const c1 = await colorOf('t1'); // 9
    // good = #2fbf71 => rgb(47,191,113)
    const good = 'rgb(47, 191, 113)';
    eq(c1, good, 't1 good green');
    assert(c4 !== good, 't4 not green (outlier), got ' + c4);
  });
  await T('TC-7.5', 'P1', 'Все команды одинаковы → std=0 → зелёные', async () => {
    const fx = FX_OUTLIER(); fx.state.people.forEach(p => p.grade = 9);
    await bootFixture(page, fx);
    const good = 'rgb(47, 191, 113)';
    for (const tid of ['t1', 't2', 't3', 't4']) {
      const c = await page.locator(`.team[data-team-id="${tid}"] .metric .flagdot`).first().evaluate(el => getComputedStyle(el).backgroundColor);
      eq(c, good, tid + ' green');
    }
  });
  await T('TC-7.7', 'P2', 'Команда без штатных → грейд «—»', async () => {
    const fx = {
      state: {
        meta: { name: "x", version: 1 }, roles: ["Backend"], locations: ["Москва"],
        teams: [{ id: "tA", name: "A", color: "#4f8cff" }],
        people: [{ id: "c1", name: "c", role: "Backend", grade: null, isContractor: true, location: "Москва", allocations: [{ teamId: "tA", fte: 1 }] }]
      }, snapshots: [], baselineId: null, uidCounter: 1000
    };
    await bootFixture(page, fx);
    eq((await page.locator('.team[data-team-id="tA"] .metric .mv').first().innerText()).trim(), '—', 'grade dash');
  });

  // ============ TS-8 analytics ============
  await T('TC-8.1', 'P1', 'Средний грейд кластера и % подрядчиков', async () => {
    await bootFixture(page, FX());
    // staff grades: p1=10(fte1 tA), p2=8(fte0.5 tA). avg = (10*1+8*0.5)/1.5=9.33 -> "9.3"
    const grade = await page.locator('#analyticsBody .stat').nth(0).locator('.v').innerText();
    assert(grade.startsWith('9.3'), 'cluster grade 9.3: ' + grade);
    const contr = await page.locator('#analyticsBody .stat').nth(1).locator('.v').innerText();
    assert(/%$/.test(contr), 'contr pct: ' + contr);
  });
  await T('TC-8.1b', 'P1', 'Сводный грейд весится по штатному grade-FTE, не по полному FTE', async () => {
    await bootFixture(page, FX_MIXGRADE());
    // X: штат г10 fte1 + подрядчик fte9; Y: штат г8 fte1. Грейды в диапазоне 7..12.
    // Корректно (вес по grade-FTE штатных): (10*1 + 8*1)/(1+1) = 9.0.
    // На старом баге (вес по полному FTE вкл. подрядчика): (10*10 + 8*1)/11 ≈ 9.8.
    const grade = await page.locator('#analyticsBody .stat').nth(0).locator('.v').innerText();
    assert(grade.startsWith('9.0'), 'cluster grade must be 9.0 (got ' + grade + ')');
  });
  await T('TC-8.2', 'P1', 'Счётчик команд-выбросов', async () => {
    await bootFixture(page, FX_OUTLIER());
    const outVal = parseInt(await page.locator('#analyticsBody .stat').nth(3).locator('.v').innerText(), 10);
    // count teams with non-green flag from DOM
    let nonGreen = 0;
    const good = 'rgb(47, 191, 113)';
    for (const tid of ['t1', 't2', 't3', 't4']) {
      const dots = page.locator(`.team[data-team-id="${tid}"] .flagdot`);
      const n = await dots.count(); let bad = false;
      for (let i = 0; i < n; i++) { if (await dots.nth(i).evaluate(el => getComputedStyle(el).backgroundColor) !== good) bad = true; }
      if (bad) nonGreen++;
    }
    eq(outVal, nonGreen, 'outlier counter matches DOM flags');
  });
  await T('TC-8.3', 'P1', 'Бар-чарт локаций: полосы реально залиты (геометрия + цвет)', async () => {
    await bootFixture(page, FX()); // 2 locations
    const rows = await count('#analyticsBody .barrow');
    eq(rows, 2, '2 location bars');
    // регрессия бага: .fill был inline <span> → height/width игнорировались, заливки нет.
    const fill = page.locator('#analyticsBody .barrow .fill').first();
    const box = await fill.evaluate(el => { const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el); return { w: r.width, h: r.height, bg: cs.backgroundColor, disp: cs.display }; });
    assert(box.h >= 4, 'fill has real height (got ' + box.h + ')');
    assert(box.w > 0, 'fill has real width (got ' + box.w + ')');
    assert(box.disp === 'block', 'fill is display:block (got ' + box.disp + ')');
    assert(box.bg && box.bg !== 'rgba(0, 0, 0, 0)' && box.bg !== 'transparent', 'fill has color (got ' + box.bg + ')');
  });
  await T('TC-8.4', 'P2', 'Сворачивание <details#analytics>', async () => {
    await bootDemo(page);
    const open1 = await page.locator('#analytics').evaluate(el => el.open);
    await page.locator('#analytics summary').click();
    const open2 = await page.locator('#analytics').evaluate(el => el.open);
    assert(open1 !== open2, 'toggled open state');
  });

  // ============ TS-9 undo/redo ============
  await T('TC-9.1', 'P0', 'Undo переноса', async () => {
    await bootFixture(page, FX());
    await html5Drag(page, '.chip[data-person-id="p1"][data-team-id="tA"]', '.team[data-team-id="tB"]');
    await page.waitForTimeout(80);
    await page.locator('#undo').click();
    await page.waitForTimeout(80);
    eq(await count('.chip[data-person-id="p1"][data-team-id="tA"]'), 1, 'back in A');
    eq(await count('.chip[data-person-id="p1"][data-team-id="tB"]'), 0, 'not in B');
  });
  await T('TC-9.2', 'P0', 'Redo', async () => {
    await bootFixture(page, FX());
    await html5Drag(page, '.chip[data-person-id="p1"][data-team-id="tA"]', '.team[data-team-id="tB"]');
    await page.waitForTimeout(80);
    await page.locator('#undo').click(); await page.waitForTimeout(60);
    await page.locator('#redo').click(); await page.waitForTimeout(60);
    eq(await count('.chip[data-person-id="p1"][data-team-id="tB"]'), 1, 're-applied to B');
  });
  await T('TC-9.3', 'P1', 'Кнопки disabled на границах', async () => {
    await bootFixture(page, FX());
    assert(await page.locator('#undo').isDisabled(), 'undo disabled at start');
    assert(await page.locator('#redo').isDisabled(), 'redo disabled at start');
  });
  await T('TC-9.4', 'P1', 'Хоткеи не срабатывают при фокусе в input', async () => {
    await bootFixture(page, FX());
    // make a change to enable undo
    await page.locator('#addTeam').click(); await page.waitForTimeout(60);
    const teams = await count('.team');
    await page.locator('#projName').focus();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(60);
    eq(await count('.team'), teams, 'undo did not fire from input');
  });

  // ============ TS-10 filters ============
  await T('TC-10.1', 'P0', 'Поиск по имени: dim/hit', async () => {
    await bootFixture(page, FX());
    await page.locator('#searchInput').fill('S10');
    await page.waitForTimeout(80);
    assert(await count('.chip.hit') >= 1, 'hit chips');
    assert(await count('.chip.dim') >= 1, 'dim chips');
  });
  await T('TC-10.2', 'P0', 'Фильтр по роли', async () => {
    await bootFixture(page, FX());
    await page.locator('#filterRole').selectOption('QA');
    await page.waitForTimeout(80);
    // p2 is QA -> hit; p1 backend -> dim
    assert(await page.locator('.chip[data-person-id="p2"]').first().evaluate(el => el.classList.contains('hit')), 'QA hit');
    assert(await page.locator('.chip[data-person-id="p1"]').first().evaluate(el => el.classList.contains('dim')), 'backend dim');
  });
  await T('TC-10.3', 'P1', 'Фильтр «Только подрядчики»', async () => {
    await bootFixture(page, FX());
    await page.locator('#filterStatus').selectOption('contractor');
    await page.waitForTimeout(80);
    assert(await page.locator('.chip[data-person-id="p3"]').first().evaluate(el => el.classList.contains('hit')), 'contractor hit');
    assert(await page.locator('.chip[data-person-id="p1"]').first().evaluate(el => el.classList.contains('dim')), 'staff dim');
  });
  await T('TC-10.4', 'P1', '«Скрывать несовпадающих» → display:none', async () => {
    await bootFixture(page, FX());
    await page.locator('#searchInput').fill('S10');
    await page.locator('#filterMode').check();
    await page.waitForTimeout(80);
    const hidden = await page.locator('.chip[data-person-id="p2"]').first().evaluate(el => getComputedStyle(el).display);
    eq(hidden, 'none', 'non-match hidden');
  });
  await T('TC-10.6', 'P2', 'Сброс фильтров возвращает доску', async () => {
    await bootFixture(page, FX());
    await page.locator('#searchInput').fill('S10'); await page.waitForTimeout(60);
    await page.locator('#searchInput').fill(''); await page.waitForTimeout(60);
    eq(await count('.chip.dim'), 0, 'no dim after reset');
    eq(await count('.chip.hit'), 0, 'no hit after reset');
  });

  // ============ TS-11 settings ============
  await T('TC-11.1', 'P0', 'Добавить роль → в фильтре и модалке', async () => {
    await bootFixture(page, FX());
    await page.locator('#settingsBtn').click();
    await page.locator('#s_newrole').fill('DevOps');
    await page.locator('[data-add="roles"]').click();
    await page.waitForTimeout(80);
    await page.locator('.modal .foot .btn.primary').click(); // close
    await page.waitForTimeout(60);
    const opts = await page.locator('#filterRole option').allInnerTexts();
    assert(opts.includes('DevOps'), 'role in filter');
    await page.locator('#addPerson').click();
    const ropts = await page.locator('#m_role option').allInnerTexts();
    assert(ropts.includes('DevOps'), 'role in person modal');
  });
  await T('TC-11.2', 'P1', 'Переименование роли инлайн', async () => {
    await bootFixture(page, FX());
    await page.locator('#settingsBtn').click();
    const inp = page.locator('#s_roles [data-roleedit="0"]');
    // переименование коммитится по реальному blur (как при Tab/клике мимо); rebind() перерисовывает
    // справочник. Синтетический change на сфокусированном input не отражает реальное поведение.
    await inp.fill('Backend2'); await inp.blur();
    await page.waitForTimeout(80);
    eq((await lsGet(page)).state.roles[0], 'Backend2', 'role renamed');
  });
  await T('TC-11.3', 'P1', 'Перемещение роли ↑/↓ меняет порядок', async () => {
    await bootFixture(page, FX());
    await page.locator('#settingsBtn').click();
    await page.locator('#s_roles [data-roledown="0"]').click();
    await page.waitForTimeout(80);
    eq((await lsGet(page)).state.roles[0], 'QA', 'QA moved to front');
  });
  await T('TC-11.4', 'P1', 'Удаление роли не меняет людей', async () => {
    await bootFixture(page, FX());
    await page.locator('#settingsBtn').click();
    await page.locator('#s_roles [data-rolerm="0"]').click(); // remove Backend
    await page.waitForTimeout(80);
    const ls = await lsGet(page);
    assert(!ls.state.roles.includes('Backend'), 'role removed from dict');
    assert(ls.state.people.find(p => p.id === 'p1').role === 'Backend', 'person keeps role');
  });
  await T('TC-11.5', 'P1', 'Добавить локацию', async () => {
    await bootFixture(page, FX());
    await page.locator('#settingsBtn').click();
    await page.locator('#s_newloc').fill('Казань');
    await page.locator('[data-add="locations"]').click();
    await page.waitForTimeout(80);
    assert((await lsGet(page)).state.locations.includes('Казань'), 'location added');
  });
  await T('TC-11.6', 'P1', 'Команды: смена цвета и удаление', async () => {
    await bootFixture(page, FX());
    await page.locator('#settingsBtn').click();
    const colorInp = page.locator('#s_teams [data-tcolor="tA"]');
    await colorInp.evaluate(el => { el.value = '#123456'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(80);
    eq((await lsGet(page)).state.teams.find(t => t.id === 'tA').color, '#123456', 'color changed');
  });
  await T('TC-11.7', 'P2', '#s_addteam добавляет команду', async () => {
    await bootFixture(page, FX());
    await page.locator('#settingsBtn').click();
    const before = (await lsGet(page)).state.teams.length;
    await page.locator('#s_addteam').click();
    await page.waitForTimeout(80);
    eq((await lsGet(page)).state.teams.length, before + 1, 'team added from settings');
  });

  // ============ TS-12 snapshots ============
  await T('TC-12.1', 'P0', 'Сохранить снимок', async () => {
    await bootFixture(page, FX());
    await page.locator('#snapBtn').click();
    await page.locator('#snap_name').fill('Base');
    await page.locator('#snap_save').click();
    await page.waitForTimeout(80);
    eq(await count('.snap-item'), 1, 'snapshot created');
  });
  await T('TC-12.2', 'P0', 'Сделать базой → compareWrap', async () => {
    await bootFixture(page, FX());
    await page.locator('#snapBtn').click();
    await page.locator('#snap_name').fill('Base');
    await page.locator('#snap_save').click(); await page.waitForTimeout(80);
    await page.locator('[data-base]').first().click(); await page.waitForTimeout(80);
    eq(await count('.snap-item.baseline'), 1, 'baseline tagged');
    await page.locator('.modal .foot .btn.primary').click(); await page.waitForTimeout(60);
    const disp = await page.locator('#compareWrap').evaluate(el => getComputedStyle(el).display);
    assert(disp !== 'none', 'compareWrap visible');
  });
  await T('TC-12.3', 'P0', 'Режим сравнения: moved-in + diff', async () => {
    await bootFixture(page, FX());
    await page.locator('#snapBtn').click();
    await page.locator('#snap_name').fill('Base');
    await page.locator('#snap_save').click(); await page.waitForTimeout(80);
    await page.locator('[data-base]').first().click(); await page.waitForTimeout(80);
    await page.locator('.modal .foot .btn.primary').click(); await page.waitForTimeout(60);
    // move p1 from A to B
    await html5Drag(page, '.chip[data-person-id="p1"][data-team-id="tA"]', '.team[data-team-id="tB"]');
    await page.waitForTimeout(80);
    await page.locator('#compareToggle').check(); await page.waitForTimeout(80);
    assert(await page.locator('.chip[data-person-id="p1"][data-team-id="tB"]').first().evaluate(el => el.classList.contains('moved-in')), 'moved-in class');
    assert(await count('.diff-strip') >= 1, 'diff strip shown');
  });
  await T('TC-12.4', 'P1', 'Восстановление снимка', async () => {
    await bootFixture(page, FX());
    await page.locator('#snapBtn').click();
    await page.locator('#snap_name').fill('Base');
    await page.locator('#snap_save').click(); await page.waitForTimeout(80);
    await page.locator('.modal .foot .btn.primary').click(); await page.waitForTimeout(60);
    // change: delete p1
    const chip = page.locator('.chip[data-person-id="p1"]').first();
    await chip.hover(); await chip.locator('[data-edit]').click({ force: true });
    await page.locator('#m_delete').click(); await page.waitForTimeout(80);
    eq(await count('.chip[data-person-id="p1"]'), 0, 'p1 deleted');
    // restore
    dialogMode = 'accept';
    await page.locator('#snapBtn').click();
    await page.locator('[data-restore]').first().click(); await page.waitForTimeout(100);
    eq(await count('.chip[data-person-id="p1"]'), 1, 'p1 restored');
  });
  await T('TC-12.5', 'P1', 'Экспорт снимка (только doc)', async () => {
    await bootFixture(page, FX());
    await page.locator('#snapBtn').click();
    await page.locator('#snap_name').fill('Base');
    await page.locator('#snap_save').click(); await page.waitForTimeout(80);
    const [dl] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('[data-export]').first().click()
    ]);
    const data = JSON.parse(require('fs').readFileSync(await dl.path(), 'utf8'));
    assert(data.teams && data.people && !data.state, 'doc only (no state wrapper)');
  });
  await T('TC-12.6', 'P1', 'Удаление снимка-базы прячет compareWrap', async () => {
    await bootFixture(page, FX());
    await page.locator('#snapBtn').click();
    await page.locator('#snap_name').fill('Base');
    await page.locator('#snap_save').click(); await page.waitForTimeout(80);
    await page.locator('[data-base]').first().click(); await page.waitForTimeout(80);
    await page.locator('[data-delsnap]').first().click(); await page.waitForTimeout(80);
    await page.locator('.modal .foot .btn.primary').click(); await page.waitForTimeout(60);
    const disp = await page.locator('#compareWrap').evaluate(el => getComputedStyle(el).display);
    eq(disp, 'none', 'compareWrap hidden');
  });
  await T('TC-12.7', 'P2', 'Снимки переживают reload', async () => {
    await bootFixture(page, FX());
    await page.locator('#snapBtn').click();
    await page.locator('#snap_name').fill('Base');
    await page.locator('#snap_save').click(); await page.waitForTimeout(80);
    await page.reload();
    await page.locator('#snapBtn').click(); await page.waitForTimeout(60);
    eq(await count('.snap-item'), 1, 'snapshot persisted');
  });
  await T('TC-12.8', 'P1', 'Round-trip импорт (safe ids): compare не даёт ложных moved-in (V2-F2 реальный кейс)', async () => {
    await bootDemo(page);
    const fs = require('fs'), os = require('os'), p = require('path');
    const fp = p.join(os.tmpdir(), 'roundtrip.json');
    fs.writeFileSync(fp, JSON.stringify(FX_ROUNDTRIP()));
    await page.locator('#fileInput').setInputFiles(fp);
    await page.waitForTimeout(200);
    // baseline восстановлен из пакета, compareWrap виден
    const disp = await page.locator('#compareWrap').evaluate(el => getComputedStyle(el).display);
    assert(disp !== 'none', 'compareWrap visible after import');
    await page.locator('#compareToggle').check(); await page.waitForTimeout(120);
    // state идентичен baseline → никто не переезжал
    eq(await count('.chip.moved-in'), 0, 'no spurious moved-in');
    eq(await count('.chip'), 2, 'both chips present');
    eq(curErrors.length, 0, 'no pageerror');
  });

  // ============ TS-13 print/png ============
  await T('TC-13.1', 'P1', 'Печать вызывает window.print', async () => {
    await bootFixture(page, FX());
    await page.evaluate(() => { window.__printed = false; window.print = () => { window.__printed = true; }; });
    await page.locator('#printBtn').click(); await page.waitForTimeout(60);
    assert(await page.evaluate(() => window.__printed), 'print called');
  });
  await T('TC-13.2', 'P1', 'PNG: download или фолбэк печати', async () => {
    await bootFixture(page, FX());
    await page.evaluate(() => { window.__printed = false; window.print = () => { window.__printed = true; }; });
    let downloaded = false;
    page.once('download', () => { downloaded = true; });
    await page.locator('#pngBtn').click();
    await page.waitForTimeout(1200);
    const printed = await page.evaluate(() => window.__printed);
    assert(downloaded || printed, `either download(${downloaded}) or print fallback(${printed})`);
    console.log(`      -> PNG outcome: download=${downloaded} printFallback=${printed}`);
  });
  await T('TC-13.3', 'P2', 'Print-CSS скрывает header/subbar', async () => {
    await bootFixture(page, FX());
    await page.emulateMedia({ media: 'print' });
    const headerDisp = await page.locator('header').evaluate(el => getComputedStyle(el).display);
    eq(headerDisp, 'none', 'header hidden in print');
    await page.emulateMedia({ media: 'screen' });
  });

  // ============ TS-14 edge cases ============
  await T('TC-14.1', 'P1', 'Пустой кластер (нет команд)', async () => {
    const fx = { state: { meta: { name: "x", version: 1 }, roles: [], locations: [], teams: [], people: [] }, snapshots: [], baselineId: null, uidCounter: 1000 };
    await bootFixture(page, fx);
    eq(await count('.team'), 0, 'no teams');
    assert(curErrors.length === 0, 'no JS errors');
  });
  await T('TC-14.2', 'P1', 'Команда только из подрядчиков → 100%', async () => {
    const fx = {
      state: {
        meta: { name: "x", version: 1 }, roles: ["Backend"], locations: ["Москва"],
        teams: [{ id: "tA", name: "A", color: "#4f8cff" }],
        people: [
          { id: "c1", name: "c1", role: "Backend", grade: null, isContractor: true, location: "Москва", allocations: [{ teamId: "tA", fte: 1 }] },
          { id: "c2", name: "c2", role: "Backend", grade: null, isContractor: true, location: "Москва", allocations: [{ teamId: "tA", fte: 1 }] }
        ]
      }, snapshots: [], baselineId: null, uidCounter: 1000
    };
    await bootFixture(page, fx);
    const team = page.locator('.team[data-team-id="tA"]');
    eq((await team.locator('.metric .mv').first().innerText()).trim(), '—', 'grade dash');
    assert((await team.locator('.metric').nth(1).locator('.mv').innerText()).includes('100%'), 'contr 100%');
  });
  await T('TC-14.3', 'P1', 'Сумма FTE по человеку > 1 допускается', async () => {
    await bootFixture(page, FX());
    const chip = page.locator('.chip[data-person-id="p1"][data-team-id="tA"]');
    await chip.hover(); await chip.locator('[data-edit]').click({ force: true });
    await page.locator('#m_allocs [data-afte]').first().fill('1');
    await page.locator('#m_addalloc').click();
    await page.locator('#m_allocs [data-ateam]').last().selectOption('tB');
    await page.locator('#m_allocs [data-afte]').last().fill('0.5');
    await page.locator('#m_save').click(); await page.waitForTimeout(80);
    const allocs = (await lsGet(page)).state.people.find(p => p.id === 'p1').allocations;
    const sum = allocs.reduce((s, a) => s + a.fte, 0);
    near(sum, 1.5, 0.001, 'sum 1.5 allowed');
    assert(curErrors.length === 0, 'no errors');
  });
  await T('TC-14.5', 'P2', 'Спецсимволы в имени экранируются (XSS)', async () => {
    await bootFixture(page, FX());
    await page.locator('#addPerson').click();
    await page.locator('#m_name').fill('<img src=x onerror=alert(1)> & "q"');
    await page.locator('#m_save').click(); await page.waitForTimeout(100);
    // no injected img element, name stored raw
    eq(await page.locator('.chip .name img').count(), 0, 'no injected img');
    assert((await lsGet(page)).state.people.some(p => p.name.includes('<img')), 'name stored raw');
    assert(curErrors.length === 0, 'no errors');
  });
  await T('TC-14.6', 'P1', 'Нет JS-ошибок в основных сценариях', async () => {
    await bootDemo(page);
    curErrors = [];
    // run a quick sequence
    await page.locator('#addTeam').click(); await page.waitForTimeout(40);
    await page.locator('#addPerson').click(); await page.locator('#m_name').fill('Seq'); await page.locator('#m_save').click(); await page.waitForTimeout(40);
    await page.locator('#undo').click(); await page.waitForTimeout(40);
    await page.locator('#redo').click(); await page.waitForTimeout(40);
    await page.locator('#searchInput').fill('Seq'); await page.waitForTimeout(40);
    await page.locator('#searchInput').fill(''); await page.waitForTimeout(40);
    await page.locator('#settingsBtn').click(); await page.waitForTimeout(40);
    await page.keyboard.press('Escape');
    eq(curErrors.length, 0, 'no pageerrors: ' + curErrors.join('|'));
  });

  // ============ TS-15 новые фичи ============
  await T('TC-15.1', 'P1', 'Кнопка «глаз» скрывает/показывает грейды', async () => {
    await bootFixture(page, FX());
    const gradeChip = page.locator('.chip:not(.contractor)').first().locator('.grade');
    const before = await gradeChip.innerText();
    assert(/\d/.test(before), 'grade visible initially: ' + before);
    await page.locator('#gradeEye').click(); await page.waitForTimeout(80);
    const masked = await page.locator('.chip:not(.contractor)').first().locator('.grade').innerText();
    assert(!/\d/.test(masked), 'grade masked after eye (got ' + masked + ')');
    // переживает reload (персистентность ui.hideGrades)
    await page.reload(); await page.waitForTimeout(80);
    const after = await page.locator('.chip:not(.contractor)').first().locator('.grade').innerText();
    assert(!/\d/.test(after), 'still masked after reload');
    // обратно
    await page.locator('#gradeEye').click(); await page.waitForTimeout(80);
    assert(/\d/.test(await page.locator('.chip:not(.contractor)').first().locator('.grade').innerText()), 'grade visible again');
  });
  await T('TC-15.2', 'P1', 'Теги сохраняются и отображаются на карточке', async () => {
    await bootDemo(page); // seed: «Алексей Орлов» имеет теги Kafka, Tech Lead
    const chip = page.locator('.chip', { has: page.locator('.name', { hasText: 'Алексей Орлов' }) }).first();
    const tags = await chip.locator('.tag-pill').allInnerTexts();
    assert(tags.includes('Kafka'), 'tag Kafka shown: ' + tags.join(','));
    // добавить новый тег через модалку
    await chip.locator('[data-edit]').click({ force: true });
    await page.locator('#m_tags').fill('Kafka, Tech Lead, Mentor');
    await page.locator('#m_save').click(); await page.waitForTimeout(80);
    const p = (await lsGet(page)).state.people.find(x => x.name === 'Алексей Орлов');
    assert(p.tags.includes('Mentor'), 'tag persisted');
    const chip2 = page.locator('.chip', { has: page.locator('.name', { hasText: 'Алексей Орлов' }) }).first();
    assert((await chip2.locator('.tag-pill').allInnerTexts()).includes('Mentor'), 'new tag rendered');
  });
  await T('TC-15.3', 'P1', 'Перетаскивание команд меняет порядок на доске', async () => {
    await bootFixture(page, FX()); // teams: tA, tB
    eq(await page.locator('.team').first().getAttribute('data-team-id'), 'tA', 'tA first initially');
    // тащим tB на tA → tB встаёт перед tA
    await page.evaluate(() => {
      const src = document.querySelector('.team[data-team-id="tB"] [data-teamdrag]');
      const tgt = document.querySelector('.team[data-team-id="tA"]');
      const dt = new DataTransfer();
      const f = (el, ty) => el.dispatchEvent(new DragEvent(ty, { bubbles: true, cancelable: true, dataTransfer: dt }));
      f(src, 'dragstart'); f(tgt, 'dragover'); f(tgt, 'drop'); f(src, 'dragend');
    });
    await page.waitForTimeout(80);
    eq(await page.locator('.team').first().getAttribute('data-team-id'), 'tB', 'tB first after reorder');
    eq((await lsGet(page)).state.teams[0].id, 'tB', 'order persisted in LS');
  });
  await T('TC-15.4', 'P1', 'Квадрат грейда окрашен по роли (разные роли — разные цвета)', async () => {
    await bootFixture(page, FX()); // Backend (idx0) и QA (idx1) без явных roleColors → палитра
    const be = await page.locator('.chip', { has: page.locator('.name', { hasText: 'S10' }) }).first().locator('.grade')
      .evaluate(el => getComputedStyle(el).backgroundColor);
    const qa = await page.locator('.chip', { has: page.locator('.name', { hasText: 'S8' }) }).first().locator('.grade')
      .evaluate(el => getComputedStyle(el).backgroundColor);
    assert(be && qa && be !== qa, 'role colors differ (Backend ' + be + ' vs QA ' + qa + ')');
  });
  await T('TC-15.5', 'P1', 'Цвет роли настраивается в справочнике и применяется к квадрату', async () => {
    await bootFixture(page, FX());
    await page.locator('#settingsBtn').click(); await page.waitForTimeout(60);
    // первый цвет-пикер роли (Backend) → задаём #ff0000
    const picker = page.locator('#s_roles [data-rolecolor]').first();
    await picker.evaluate(el => { el.value = '#ff0000'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForTimeout(60);
    await page.keyboard.press('Escape');
    const be = await page.locator('.chip', { has: page.locator('.name', { hasText: 'S10' }) }).first().locator('.grade')
      .evaluate(el => getComputedStyle(el).backgroundColor);
    eq(be, 'rgb(255, 0, 0)', 'Backend grade square is red');
    assert((await lsGet(page)).state.roleColors.Backend === '#ff0000', 'roleColors persisted');
  });

  await browser.close();

  // ---------- summary ----------
  const byPrio = {};
  for (const r of results) {
    byPrio[r.prio] = byPrio[r.prio] || { pass: 0, fail: 0 };
    byPrio[r.prio][r.status]++;
  }
  const fails = results.filter(r => r.status === 'fail');
  console.log('\n==================== SUMMARY ====================');
  for (const pr of ['P0', 'P1', 'P2']) {
    const b = byPrio[pr] || { pass: 0, fail: 0 };
    console.log(`${pr}: ${b.pass} pass / ${b.fail} fail`);
  }
  console.log(`TOTAL: ${results.filter(r => r.status === 'pass').length}/${results.length} passed`);
  if (fails.length) {
    console.log('\nFAILURES:');
    for (const f of fails) console.log(`  ${f.id} (${f.prio}) ${f.name}\n     ${f.msg}`);
  }
  process.exit(fails.some(f => f.prio === 'P0') ? 1 : 0);
})();
