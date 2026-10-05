/* ============================================================================
 * EHS 管理平台 · 前端（原生 JS，无框架、无构建）
 *
 * 设计原则：**状态流转只走动作按钮，不给一个"状态"下拉框让你随便改**。
 * 台账可信的前提是"到过什么状态"有记录，而不是有人能直接把状态改成"已销号"。
 * 所以界面上与状态有关的东西全是按钮：派单 / 提交复查 / 复查通过 / 复查不通过 / 作废。
 *
 * 后端会拒绝非法流转（见 server/domain.js），这里再做一层"按钮该不该出现"的判断——
 * 两层都做是刻意的：前端负责别让人点了才知道不行，后端负责防止绕过界面乱调接口。
 * ========================================================================= */
(function () {
  'use strict';

  var state = {
    meta: { levels: [], statuses: [], sources: [], areas: [], today: '' },
    items: [],
    stats: null,
    filter: { status: '', level: '', q: '', overdue: false },
    current: null,
    modal: null,
  };

  var $ = function (id) { return document.getElementById(id); };

  var el = function (tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key === 'dataset') Object.keys(value).forEach(function (k) { node.dataset[k] = value[k]; });
        else if (key.indexOf('on') === 0 && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, String(value));
      });
    }
    [].concat(children || []).forEach(function (child) {
      if (child === null || child === undefined || child === false) return;
      node.append(typeof child === 'object' ? child : document.createTextNode(String(child)));
    });
    return node;
  };

  function toast(message, isError) {
    var box = $('toast');
    box.textContent = message;
    box.className = 'toast' + (isError ? ' is-error' : '');
    box.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { box.hidden = true; }, 4200);
  }

  /** 统一的请求封装：把后端的 error 原样抛出来（领域规则的拒绝信息要看得见）。 */
  function api(path, options) {
    var init = { method: (options && options.method) || 'GET', headers: { accept: 'application/json' } };
    if (options && options.json !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(options.json);
    }
    return fetch(path, init).then(function (response) {
      return response.json().catch(function () { return null; }).then(function (payload) {
        if (!response.ok || (payload && payload.ok === false)) {
          throw new Error((payload && payload.error) || ('HTTP ' + response.status));
        }
        return payload;
      });
    });
  }

  var statusLabel = function (id) {
    var found = state.meta.statuses.filter(function (item) { return item.id === id; })[0];
    return found ? found.label : id;
  };

  /* ------------------------------------------------------------------ 渲染 -- */

  function renderStats() {
    var stats = state.stats || {};
    var cards = [
      { key: 'total', label: '隐患总数', value: stats.total || 0 },
      { key: 'open', label: '待整改', value: (stats.open || 0) + (stats.rectifying || 0), tone: 'warn' },
      { key: 'overdue', label: '已逾期', value: stats.overdue || 0, tone: (stats.overdue ? 'alert' : '') },
      { key: 'review', label: '待复查', value: stats.review || 0, tone: 'warn' },
      { key: 'rate', label: '闭环率', value: stats.closeRate === null || stats.closeRate === undefined ? '—' : stats.closeRate + '%', tone: 'ok' },
    ];
    $('stats').replaceChildren.apply($('stats'), cards.map(function (card) {
      return el('div', { class: 'stat' + (card.tone ? ' is-' + card.tone : '') }, [
        el('div', { class: 'stat-value', text: String(card.value) }),
        el('div', { class: 'stat-label', text: card.label }),
      ]);
    }));
  }

  function renderTabs() {
    var stats = state.stats || {};
    var counts = {
      '': stats.total || 0,
      open: stats.open || 0,
      rectifying: stats.rectifying || 0,
      review: stats.review || 0,
      closed: stats.closed || 0,
      void: stats.void || 0,
    };
    var options = [{ id: '', label: '全部' }].concat(state.meta.statuses.map(function (item) {
      return { id: item.id, label: item.label };
    }));
    $('statusTabs').replaceChildren.apply($('statusTabs'), options.map(function (option) {
      return el('button', {
        class: 'tab', type: 'button', role: 'tab',
        'aria-selected': String(state.filter.status === option.id),
        onclick: function () { state.filter.status = option.id; void load(); },
      }, [
        el('span', { text: option.label }),
        el('span', { class: 'n', text: String(counts[option.id] || 0) }),
      ]);
    }));
  }

  function levelPill(level) {
    return el('span', { class: 'pill pill-' + (level === 'major' ? 'major' : 'general'), text: level === 'major' ? '重大' : '一般' });
  }

  function statusPill(item) {
    if (item.overdue) return el('span', { class: 'pill pill-overdue', text: '逾期' });
    return el('span', { class: 'pill pill-' + item.status, text: statusLabel(item.status) });
  }

  function renderTable() {
    var items = state.items;
    var empty = $('empty');
    var table = $('table');
    if (items.length === 0) {
      table.replaceChildren();
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    var head = el('div', { class: 'row row-head', role: 'row' }, [
      el('span', { text: '编号' }),
      el('span', { text: '隐患' }),
      el('span', { text: '级别' }),
      el('span', { text: '责任人' }),
      el('span', { text: '期限' }),
      el('span', { text: '状态' }),
    ].map(function (node, index) {
      // 窄屏用 data-label 变成卡片里的字段名
      node.dataset.label = ['编号', '隐患', '级别', '责任人', '期限', '状态'][index];
      return node;
    }));
    var rows = items.map(function (item) {
      return el('button', {
        class: 'row', type: 'button', role: 'row', onclick: function () { void openDrawer(item.id); },
      }, [
        el('span', { class: 'code', text: item.code, dataset: { label: '编号' } }),
        el('span', { class: 'desc', dataset: { label: '隐患' } }, [
          el('strong', { text: item.description }),
          el('span', { text: [item.area, item.location].filter(Boolean).join(' · ') }),
        ]),
        el('span', { dataset: { label: '级别' } }, [levelPill(item.level)]),
        el('span', { class: 'owner', text: item.owner || '未派单', dataset: { label: '责任人' } }),
        el('span', {
          class: 'due' + (item.overdue ? ' is-overdue' : ''),
          dataset: { label: '期限' },
          text: item.due ? (item.overdue ? item.due + '（逾期 ' + Math.abs(item.daysLeft) + ' 天）' : item.due + '（剩 ' + item.daysLeft + ' 天）') : '未定期限',
        }),
        el('span', { dataset: { label: '状态' } }, [statusPill(item)]),
      ]);
    });
    table.replaceChildren.apply(table, [head].concat(rows));
  }

  /* ------------------------------------------------------------------ 抽屉 -- */

  function kv(label, value) {
    return el('div', {}, [el('span', { text: label }), el('strong', { text: value || '—' })]);
  }

  function openDrawer(id) {
    api('/api/hazards/' + encodeURIComponent(id)).then(function (data) {
      state.current = data.item;
      var item = data.item;
      $('drawerCode').textContent = item.code;
      $('drawerTitle').textContent = item.description;

      var body = $('drawerBody');
      body.replaceChildren(
        el('div', { class: 'kv' }, [
          kv('区域', item.area),
          kv('具体部位', item.location),
          kv('级别', item.level === 'major' ? '重大隐患（需停用并上报）' : '一般隐患'),
          kv('来源', (state.meta.sources.filter(function (s) { return s.id === item.source; })[0] || {}).label || item.source),
          kv('发现时间', String(item.foundAt).replace('T', ' ')),
          kv('发现人', item.foundBy),
          kv('状态', statusLabel(item.status) + (item.overdue ? '（已逾期 ' + Math.abs(item.daysLeft) + ' 天）' : '')),
          kv('责任人', item.owner),
          kv('完成期限', item.due ? item.due + (item.daysLeft !== null ? '（' + (item.daysLeft >= 0 ? '剩 ' + item.daysLeft + ' 天' : '逾期 ' + Math.abs(item.daysLeft) + ' 天') + '）' : '') : ''),
          kv('验收标准', item.criteria),
          kv('整改情况', item.submitNote),
          kv('复查人', item.reviewer),
          kv('复查结论', item.reviewResult === 'pass' ? '通过' : item.reviewResult === 'fail' ? '不通过' : ''),
          kv('复查说明', item.reviewNote),
          item.voidReason ? kv('作废原因', item.voidReason) : null,
        ].filter(Boolean)),
        el('div', { class: 'section-title', text: '流转留痕' }),
        el('ul', { class: 'trail' }, (data.actions || []).map(function (action) {
          return el('li', {}, [
            el('div', { class: 'when', text: String(action.at).replace('T', ' ').slice(0, 16) + (action.actor ? ' · ' + action.actor : '') }),
            el('div', { class: 'what', text: action.detail || action.action }),
          ]);
        })),
      );

      // 动作按钮按状态给（后端还会再校验一次）
      var foot = $('drawerFoot');
      var buttons = [];
      if (item.status === 'open' || item.status === 'rectifying') {
        buttons.push(el('button', {
          class: 'btn btn-accent', type: 'button',
          text: item.owner ? '改派/修改派单' : '派单（定人、定期限、定标准）',
          onclick: function () { openAssignModal(item); },
        }));
      }
      if (item.status === 'rectifying') {
        buttons.push(el('button', {
          class: 'btn', type: 'button', text: '整改完成，提交复查',
          onclick: function () { openSubmitModal(item); },
        }));
      }
      if (item.status === 'review') {
        buttons.push(el('button', {
          class: 'btn btn-accent', type: 'button', text: '复查通过，销号',
          onclick: function () { openReviewModal(item, 'pass'); },
        }));
        buttons.push(el('button', {
          class: 'btn', type: 'button', text: '复查不通过，退回整改',
          onclick: function () { openReviewModal(item, 'fail'); },
        }));
      }
      buttons.push(el('button', {
        class: 'btn', type: 'button', text: '编辑',
        onclick: function () { openEditModal(item); },
      }));
      if (item.status !== 'closed' && item.status !== 'void') {
        buttons.push(el('button', {
          class: 'btn btn-danger', type: 'button', text: '作废',
          onclick: function () { openVoidModal(item); },
        }));
      }
      foot.replaceChildren.apply(foot, buttons);

      $('drawer').hidden = false;
      document.body.style.overflow = 'hidden';
    }).catch(function (error) { toast(error.message, true); });
  }

  function closeDrawer() {
    $('drawer').hidden = true;
    document.body.style.overflow = '';
  }

  /* ------------------------------------------------------------------ 表单 -- */

  function field(label, input, hint, required) {
    return el('div', { class: 'field' }, [
      el('label', {}, [label, required ? el('span', { class: 'req', text: ' *' }) : null]),
      input,
      hint ? el('div', { class: 'hint', text: hint }) : null,
    ]);
  }

  function input(name, value, placeholder, type) {
    return el('input', {
      class: 'input', name: name, value: value || '', placeholder: placeholder || '',
      type: type || 'text', autocomplete: 'off',
    });
  }

  function textarea(name, value, placeholder) {
    return el('textarea', { class: 'input', name: name, placeholder: placeholder || '' }, [value || '']);
  }

  /**
   * 打开表单。
   * @param {object} config - `{ title, submitText, fields, initial, onSubmit }`
   */
  function openModal(config) {
    state.modal = config;
    $('modalTitle').textContent = config.title;
    $('modalSubmit').textContent = config.submitText || '确定';
    $('modalError').hidden = true;
    $('modalSubmit').disabled = false;
    var fields = $('modalFields');
    fields.replaceChildren.apply(fields, config.fields);
    $('modal').hidden = false;
    var first = fields.querySelector('input, textarea, select');
    if (first) first.focus();
  }

  function closeModal() {
    $('modal').hidden = true;
    state.modal = null;
  }

  function openCreateModal() {
    openModal({
      title: '录入隐患',
      submitText: '录入',
      fields: [
        field('隐患描述', textarea('description', '', '写清具体是什么问题，例如：预处理车间配电箱未上锁'), '一句话说清，检查的人靠它判断。', true),
        el('div', { class: 'field-2' }, [
          field('区域 / 车间', input('area', '', '例如：预处理车间'), null, true),
          field('具体部位', input('location', '', '例如：东侧配电柜')),
        ]),
        el('div', { class: 'field-2' }, [
          field('级别', el('select', { class: 'input', name: 'level' }, state.meta.levels.map(function (item) {
            return el('option', { value: item.id, text: item.label });
          }))),
          field('发现人', input('foundBy', '', '你的名字')),
        ]),
        field('来源', el('select', { class: 'input', name: 'source' }, state.meta.sources.map(function (item) {
          return el('option', { value: item.id, text: item.label });
        }))),
      ],
      onSubmit: function (data) {
        return api('/api/hazards', { method: 'POST', json: data }).then(function () {
          toast('已录入，下一步：派单（定人、定期限、定标准）');
          return true;
        });
      },
    });
  }

  function openAssignModal(item) {
    openModal({
      title: '派单 · ' + item.code,
      submitText: '派单',
      fields: [
        field('责任人', input('owner', item.owner || '', '写具体人名'), '不写人名，这条整改就没人负责到底。', true),
        field('完成期限', input('due', item.due || state.meta.today, '', 'date'), null, true),
        field('验收标准', textarea('criteria', item.criteria || '', '改成什么样算改到位，例如：配电箱加锁并贴标识，钥匙由班组长保管'), '复查的人按这条判断，不写清楚就会扯皮。', true),
        field('操作人', input('actor', item.foundBy || '', '谁在派单（留痕用）')),
      ],
      onSubmit: function (data) {
        return api('/api/hazards/' + encodeURIComponent(item.id) + '/assign', { method: 'POST', json: data }).then(function () {
          toast('已派单给 ' + data.owner + '，' + data.due + ' 前完成');
          return true;
        });
      },
    });
  }

  function openSubmitModal(item) {
    openModal({
      title: '提交复查 · ' + item.code,
      submitText: '提交复查',
      fields: [
        field('做了什么', textarea('note', item.submitNote || '', '例如：已加锁并贴标识，钥匙交班组长保管'), '复查的人靠这句话决定去现场看什么。', true),
        field('操作人', input('actor', item.owner || '', '谁提交的')),
      ],
      onSubmit: function (data) {
        return api('/api/hazards/' + encodeURIComponent(item.id) + '/submit', { method: 'POST', json: data }).then(function () {
          toast('已提交复查，等复查人确认');
          return true;
        });
      },
    });
  }

  function openReviewModal(item, result) {
    openModal({
      title: (result === 'pass' ? '复查通过，销号' : '复查不通过，退回整改') + ' · ' + item.code,
      submitText: result === 'pass' ? '确认销号' : '退回整改',
      fields: [
        field('复查人', input('reviewer', '', '谁去现场看过'), '销号必须有人签字：这是台账能不能被检查认可的关键。', true),
        field('复查说明', textarea('note', '', result === 'pass' ? '现场看到什么（可留空）' : '不通过的原因，整改方要知道改什么'), null, result === 'fail'),
      ],
      onSubmit: function (data) {
        data.result = result;
        return api('/api/hazards/' + encodeURIComponent(item.id) + '/review', { method: 'POST', json: data }).then(function () {
          toast(result === 'pass' ? '已销号' : '已退回整改');
          return true;
        });
      },
    });
  }

  function openVoidModal(item) {
    openModal({
      title: '作废 · ' + item.code,
      submitText: '确认作废',
      fields: [
        field('作废原因', textarea('reason', '', '例如：重复录入 / 描述有误'), '作废比删除好：记录还在，检查时说得清。', true),
        field('操作人', input('actor', '', '谁作废的')),
      ],
      onSubmit: function (data) {
        return api('/api/hazards/' + encodeURIComponent(item.id) + '/void', { method: 'POST', json: data }).then(function () {
          toast('已作废');
          return true;
        });
      },
    });
  }

  function openEditModal(item) {
    openModal({
      title: '编辑 · ' + item.code,
      submitText: '保存',
      fields: [
        field('隐患描述', textarea('description', item.description, ''), null, true),
        el('div', { class: 'field-2' }, [
          field('区域 / 车间', input('area', item.area, ''), null, true),
          field('具体部位', input('location', item.location, '')),
        ]),
        el('div', { class: 'field-2' }, [
          field('级别', el('select', { class: 'input', name: 'level' }, state.meta.levels.map(function (option) {
            return el('option', { value: option.id, text: option.label, selected: option.id === item.level });
          }))),
          field('发现人', input('foundBy', item.foundBy, '')),
        ]),
      ],
      onSubmit: function (data) {
        return api('/api/hazards/' + encodeURIComponent(item.id), { method: 'PATCH', json: data }).then(function () {
          toast('已保存');
          return true;
        });
      },
    });
  }

  /* ------------------------------------------------------------------ 装配 -- */

  function load() {
    var params = new URLSearchParams();
    if (state.filter.status) params.set('status', state.filter.status);
    if (state.filter.level) params.set('level', state.filter.level);
    if (state.filter.overdue) params.set('overdue', '1');
    if (state.filter.q.trim()) params.set('q', state.filter.q.trim());
    return api('/api/hazards?' + params.toString()).then(function (data) {
      state.items = data.items || [];
      state.stats = data.stats || null;
      renderStats();
      renderTabs();
      renderTable();
    }).catch(function (error) { toast('读取失败：' + error.message, true); });
  }

  function boot() {
    $('todayLabel').textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    $('newHazardBtn').addEventListener('click', openCreateModal);
    $('searchInput').addEventListener('input', function (event) {
      state.filter.q = event.target.value;
      clearTimeout(boot._timer);
      boot._timer = setTimeout(function () { void load(); }, 220);
    });
    $('levelFilter').addEventListener('change', function (event) { state.filter.level = event.target.value; void load(); });
    $('overdueFilter').addEventListener('change', function (event) { state.filter.overdue = event.target.checked; void load(); });

    // 关闭手势：遮罩、✕、Esc（现场用键盘的人不少）
    document.addEventListener('click', function (event) {
      if (event.target.closest && event.target.closest('[data-close]')) {
        if (!$('modal').hidden) closeModal(); else closeDrawer();
      }
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!$('modal').hidden) closeModal();
      else if (!$('drawer').hidden) closeDrawer();
    });

    $('modalForm').addEventListener('submit', function (event) {
      event.preventDefault();
      if (!state.modal) return;
      var form = event.target;
      var data = {};
      Array.prototype.forEach.call(form.querySelectorAll('input, textarea, select'), function (node) {
        if (node.name) data[node.name] = node.value;
      });
      var submit = $('modalSubmit');
      submit.disabled = true;
      var original = submit.textContent;
      submit.textContent = '正在提交…';
      state.modal.onSubmit(data).then(function (ok) {
        if (ok === false) return;
        closeModal();
        void load();
        if (!$('drawer').hidden && state.current) void openDrawer(state.current.id);
      }).catch(function (error) {
        var box = $('modalError');
        box.textContent = error.message;
        box.hidden = false;
      }).finally(function () {
        submit.disabled = false;
        submit.textContent = original;
      });
    });

    return api('/api/meta').then(function (meta) {
      state.meta = meta;
      return load();
    });
  }

  void boot();
})();
