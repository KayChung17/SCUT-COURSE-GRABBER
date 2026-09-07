(function () {
    'use strict';

    const global = window;
    const instanceKey = '__SCUT_COURSE_GRABBER__';

    if (global[instanceKey]) {
        global[instanceKey].stop();
    }

    const DEFAULT_INTERVAL = 5000;
    const TARGET_COURSES = [
        // { code: '课程号或课程名称', priority: 1 },
        // { code: '课程号', priority: 2, timeFilter: ['星期一'], teacherFilter: ['教师姓名'] },
    ];

    let running = false;
    let busy = false;
    let timerId = null;
    let attemptCount = 0;
    let interval = DEFAULT_INTERVAL;
    let targets = [];

    function log(message, level = 'info') {
        const prefix = `[华工选课 ${new Date().toLocaleTimeString()}]`;
        const output = `${prefix} ${message}`;
        if (level === 'error') {
            console.error(output);
        } else if (level === 'warning') {
            console.warn(output);
        } else {
            console.log(output);
        }
    }

    function sleep(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    function isVisible(element) {
        if (!element) {
            return false;
        }
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.offsetParent !== null;
    }

    function isCourseCode(value) {
        return /^\d+$/.test(String(value).trim());
    }

    function textOf(element) {
        return (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function normalizeCourseText(value) {
        return String(value || '')
            .replace(/\s+/g, '')
            .replace(/[（）]/g, match => match === '（' ? '(' : ')')
            .toLowerCase();
    }

    function getCoursePanelMeta(panel) {
        const title = panel.querySelector('.kc_head .kcmc');
        const titleText = textOf(title);
        const visibleCode = titleText.match(/^[（(]\s*([^）)]+?)\s*[）)]/);
        const internalCode = panel.querySelector('.kc_head input[name="kch_id"]');
        const nameLink = panel.querySelector('.kc_head .kcmc a');

        return {
            code: visibleCode ? visibleCode[1].trim() : '',
            internalCode: internalCode?.value?.trim() || '',
            name: textOf(nameLink),
            titleText
        };
    }

    function matchesCoursePanel(panel, target) {
        const input = normalizeCourseText(target.code);
        const meta = getCoursePanelMeta(panel);

        if (isCourseCode(input)) {
            return normalizeCourseText(meta.code) === input ||
                normalizeCourseText(meta.internalCode) === input;
        }

        return normalizeCourseText(meta.name).includes(input) ||
            normalizeCourseText(meta.titleText).includes(input);
    }

    function findSearchInput() {
        return document.querySelector(
            'input[name="searchInput"], input[placeholder*="课程号"], input[placeholder*="课程名称"], #searchBox'
        );
    }

    function findSearchButton() {
        const queryButton = document.querySelector('button[name="query"]');
        if (queryButton && isVisible(queryButton)) {
            return queryButton;
        }

        const elements = document.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
        return Array.from(elements).find(element => {
            const text = textOf(element);
            return isVisible(element) && (text === '查询' || text === '搜索' || text.includes('查询'));
        });
    }

    async function searchCourse(code) {
        const input = findSearchInput();
        const button = findSearchButton();
        if (!input || !button) {
            log('未找到课程查询控件，请先打开自主选课页面', 'warning');
            return false;
        }

        if (input.value !== code) {
            const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            descriptor.set.call(input, code);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        button.click();
        await sleep(1000);
        return true;
    }

    function expandCourse(code) {
        const heads = document.querySelectorAll('.panel-heading.kc_head');

        for (const head of heads) {
            const coursePanel = head.closest('.panel');
            const matched = coursePanel && matchesCoursePanel(coursePanel, { code });

            if (matched) {
                const detailRows = coursePanel?.querySelectorAll('table tbody tr.body_tr') || [];
                const hasVisibleDetail = Array.from(detailRows).some(isVisible);
                if (!hasVisibleDetail) {
                    head.click();
                }
                return true;
            }
        }
        return false;
    }

    function matchesTarget(row, target) {
        const input = normalizeCourseText(target.code);
        const coursePanel = row.closest('.panel.panel-info');
        if (coursePanel && matchesCoursePanel(coursePanel, target)) {
            return true;
        }

        const codeCell = row.querySelector('.kch_id, td.kch_id');
        if (isCourseCode(input) && normalizeCourseText(textOf(codeCell)) === input) {
            return true;
        }

        const className = normalizeCourseText(textOf(row.querySelector('.jxbmc, td.jxbmc')));
        return className.includes(input);
    }

    function matchesFilters(row, target) {
        const timeFilter = target.timeFilter || [];
        const teacherFilter = target.teacherFilter || [];
        const timeText = textOf(row.querySelector('.sksj, td.sksj'));
        const teacherText = textOf(row.querySelector('.jsxmzc, td.jsxmzc'));

        const timeMatched = timeFilter.length === 0 || timeFilter.some(value => timeText.includes(value));
        const teacherMatched = teacherFilter.length === 0 || teacherFilter.some(value => teacherText.includes(value));
        return timeMatched && teacherMatched;
    }

    function hasCapacity(row) {
        const full = row.querySelector('.full, td.full');
        if (full && isVisible(full)) {
            return false;
        }

        const selectedElement = row.querySelector('.rsxx .jxbrs');
        const capacityElement = row.querySelector('.rsxx .jxbrl');
        const capacityText = textOf(row.querySelector('.rsxx, td.rsxx'));
        if (capacityText.includes('已满')) {
            return false;
        }

        const match = selectedElement && capacityElement
            ? { selected: selectedElement.textContent.trim(), capacity: capacityElement.textContent.trim() }
            : capacityText.match(/(\d+)\s*\/\s*(\d+)/);
        const selected = Number(match?.selected || match?.[1]);
        const capacity = Number(match?.capacity || match?.[2]);
        return Boolean(match && selected < capacity && capacity > 0);
    }

    function canSelect(row) {
        const rowText = textOf(row);
        return rowText.includes('选课') && !rowText.includes('退选');
    }

    function findRows(target) {
        return Array.from(document.querySelectorAll('table tbody tr.body_tr'))
            .filter(row => matchesTarget(row, target))
            .filter(row => canSelect(row))
            .filter(row => matchesFilters(row, target));
    }

    function findSelectButton(row) {
        const elements = row.querySelectorAll('button, a, input[type="button"], input[type="submit"], [onclick]');
        return Array.from(elements).find(element => {
            const text = textOf(element);
            return isVisible(element) && text.includes('选课') && !text.includes('退选');
        });
    }

    function findConfirmButton(scope = document) {
        const elements = scope.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
        return Array.from(elements).find(element => {
            const text = textOf(element);
            return isVisible(element) && /确定|确认|提交|OK/i.test(text);
        });
    }

    function findVisibleModal() {
        return Array.from(document.querySelectorAll('.modal, .bootbox, [role="dialog"], [role="alert"]'))
            .find(isVisible);
    }

    function closeConflictDialog() {
        const modal = findVisibleModal();
        const button = findConfirmButton(modal || document);
        if (button) {
            button.click();
        }
    }

    function hasConflict(modal) {
        const result = modal || findVisibleModal();
        const resultText = textOf(result);
        return resultText.includes('时间冲突') || resultText.includes('上课时间与其他教学班有冲突');
    }

    function hasSuccess(target, modal) {
        const resultText = textOf(modal);
        if (/选课成功|操作成功/.test(resultText)) {
            return true;
        }
        return findRows(target).some(row => textOf(row).includes('退选') || textOf(row).includes('已选'));
    }

    async function selectRow(row, target) {
        const button = findSelectButton(row);
        if (!button) {
            log(`${target.code} 未找到选课按钮`, 'warning');
            return false;
        }

        log(`${target.code} 检测到余量，点击选课按钮`);
        button.click();
        await sleep(600);

        const modal = findVisibleModal();
        const confirm = findConfirmButton(modal || document);
        if (confirm) {
            confirm.click();
            await sleep(1800);
        }

        const resultModal = findVisibleModal();
        if (hasConflict(resultModal)) {
            log(`${target.code} 存在时间冲突`, 'warning');
            closeConflictDialog();
            return false;
        }

        if (hasSuccess(target, resultModal)) {
            log(`${target.code} 选课成功`, 'info');
            return true;
        }

        log(`${target.code} 未确认成功，下一轮继续尝试`, 'warning');
        return false;
    }

    async function attempt() {
        if (!running || busy) {
            return;
        }

        busy = true;
        attemptCount++;

        try {
            const activeTargets = targets
                .filter(target => !target.success)
                .sort((left, right) => (left.priority || 999) - (right.priority || 999));

            for (const target of activeTargets) {
                await searchCourse(target.code);
                expandCourse(target.code);
                await sleep(300);

                if (textOf(document.body).includes('对不起，当前不属于选课阶段')) {
                    log('当前不属于选课阶段，等待下一轮检查', 'info');
                    continue;
                }

                const rows = findRows(target);
                if (rows.length === 0) {
                    log(`${target.code} 未找到可选教学班`, 'info');
                    continue;
                }

                for (const row of rows) {
                    if (!hasCapacity(row)) {
                        continue;
                    }
                    if (await selectRow(row, target)) {
                        target.success = true;
                        break;
                    }
                }
            }

            if (targets.length > 0 && targets.every(target => target.success)) {
                stop();
                log('所有目标课程均已选上');
            }
        } finally {
            busy = false;
        }
    }

    function start(customTargets = TARGET_COURSES, customInterval = DEFAULT_INTERVAL) {
        if (running) {
            log('脚本已经在运行', 'warning');
            return;
        }

        targets = customTargets.map(target => typeof target === 'string' ? { code: target, priority: 999 } : { ...target });
        if (targets.length === 0) {
            log('没有配置目标课程，请先填写 TARGET_COURSES', 'warning');
            return;
        }
        interval = customInterval;
        running = true;
        attemptCount = 0;
        log(`开始监控 ${targets.length} 门课程，检查间隔 ${interval} 毫秒`);
        attempt();
        timerId = setInterval(attempt, interval);
    }

    function stop() {
        running = false;
        if (timerId) {
            clearInterval(timerId);
            timerId = null;
        }
        log('脚本已停止');
    }

    function status() {
        const result = {
            running,
            busy,
            attemptCount,
            interval,
            targets: targets.map(target => ({ code: target.code, success: Boolean(target.success) }))
        };
        console.table(result.targets);
        console.log(result);
        return result;
    }

    global[instanceKey] = { start, stop, status };
    global.scutGrab = global[instanceKey];

    log('脚本已加载。配置 TARGET_COURSES 后执行 scutGrab.start()');
})();
