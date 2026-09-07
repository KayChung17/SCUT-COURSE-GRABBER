// 仓库地址（持续维护、更新中）: https://github.com/ceilf6/Auto_courseGrabber
// https://github.com/ceilf6
// https://blog.csdn.net/2301_78856868

// 使用方法:
// 1. 登录教务系统并进入选课页面
// 2. 配置目标课程列表 TARGET_COURSES（现在已经支持UI界面，所以在UI界面上配置也没事）
// 3. 按F12打开控制台，粘贴此脚本并执行
// 4. 输入 grab.start() 开始抢课

// 注意!!! 目标课程得在页面中出现（可以在不是选课时间到目标课程展示的页面并打开定时开抢功能、教学班卡片信息本脚本已经自动实现展开所以不重要），DOM树一定得展开否则无法找到 !!!

(function () {
    // ========= 防止重复粘贴/重复执行 =========
    const __CG_GLOBAL__ = (typeof window !== 'undefined' ? window : globalThis);
    const __CG_LOADED_KEY__ = '__AUTO_COURSE_GRABBER_LOADED__';
    const __CG_INSTANCE_KEY__ = '__AUTO_COURSE_GRABBER_INSTANCE_ID__';
    const __CG_REFRESH_LOCK_KEY__ = '__AUTO_COURSE_GRABBER_LAST_REFRESH_AT__';

    if (__CG_GLOBAL__[__CG_LOADED_KEY__]) {
        try {
            // 尝试停止旧实例（如果旧实例仍挂在 window.grab 上）
            if (__CG_GLOBAL__.grab && typeof __CG_GLOBAL__.grab.stop === 'function') {
                __CG_GLOBAL__.grab.stop();
            }
        } catch (e) {
            // 忽略停止失败
        }
        console.warn('[抢课脚本] 检测到脚本已加载过一次：已尝试停止旧实例，并将覆盖为新实例。');
    }

    __CG_GLOBAL__[__CG_LOADED_KEY__] = true;
    __CG_GLOBAL__[__CG_INSTANCE_KEY__] = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    'use strict';

    // ========== 配置参数 ==========
    // 支持多门课程同时抢课，格式: [{code: '课程号或课程名称', priority: 优先级, timeFilter: 时间过滤, teacherFilter: 教师过滤}]
    // code 字段支持两种输入方式：
    //   1. 课程号（纯数字）：如 '23286514'
    //   2. 课程名称（包含中文）：如 '机器学习'、'计算机控制'
    const TARGET_COURSES = [
        // 示例配置:
        // { code: '23286514', priority: 1 },  // 使用课程号，高优先级，无过滤
        // { code: '机器学习', priority: 1 },  // 使用课程名称，高优先级，无过滤
        // { code: 'CS102', priority: 2, timeFilter: ['星期一', '星期三'] },  // 只选星期一或星期三的课
        // { code: 'CS103', priority: 3, teacherFilter: ['张三', '李四'] }   // 只选张三或李四的课
        // { code: 'CS104', priority: 4, timeFilter: ['第1-2节'], teacherFilter: ['王五'] }  // 同时过滤时间和教师
    ];

    const CHECK_INTERVAL = 1000;            // 检查间隔(毫秒)
    const MAX_ATTEMPTS = Number.POSITIVE_INFINITY; // 持续监控，直到手动停止或选课成功
    const MAX_FAILED_ATTEMPTS = 10;          // 仅用于状态展示，不因临时失败停止监控
    const RETRY_DELAY = 3000;               // 重试延迟(毫秒)
    const CONCURRENT_ENABLED = true;        // 是否启用并发抢课
    const CLICK2EXPEND_ENABLED = true;     // 用户设置: 是否在 jQuery 后自动展开目标课程信息，用于时间筛选和教师筛选

    let click2expend_enabled = true;       // 用于脚本自动关闭

    // ========== 过滤器配置 ==========
    // 全局时间过滤器（可选）- 留空表示不过滤，支持多个关键词，满足任意一个即可
    // 示例: ['星期一', '星期三', '第1-2节', '第11-12节']
    const GLOBAL_TIME_FILTER = [];

    // 全局教师过滤器（可选）- 留空表示不过滤，支持多个关键词，满足任意一个即可
    // 示例: ['张三', '张三', '讲师']
    const GLOBAL_TEACHER_FILTER = [];

    // ========== 全局状态管理 ==========
    let attemptCount = 0;
    let isRunning = false;
    let intervalId = null;
    let refreshInProgress = false;          // 避免刷新分支在 attemptCount 未变化时被重复触发
    let refreshTimeoutId = null;            // 刷新后延迟抢课的 timeout

    // 多课程状态管理
    let courseStates = new Map();           // 每门课程的状态: {courseCode: {attempts, failed, tried, conflicted, selecting, success}}
    let selectedCourses = new Set();        // 已成功选上的课程
    let activeCourses = new Set();          // 当前活跃的课程列表

    // 全局选课队列
    let selectingQueue = [];                // 正在处理的选课任务队列
    let isProcessingQueue = false;          // 是否正在处理队列

    // 定时开抢相关
    let scheduledTime = null;               // 计划开抢时间
    let schedulerIntervalId = null;         // 定时器ID
    let isScheduled = false;                // 是否已设置定时

    // ========== 工具函数 ==========

    /**
     * 安全的字符串分割与过滤函数
     * 避免使用可能被页面/库篡改的 Array.prototype.filter
     * @param {string} input - 原始输入字符串
     * @param {RegExp} [separatorRegex=/[，,;；]+/] - 分隔符正则
     * @returns {string[]} - 过滤后的非空字符串数组
     */
    function safeParseFilterInput(input, separatorRegex = /[，,;；]+/) {
        if (!input || typeof input !== 'string') {
            return [];
        }

        const raw = input.trim();
        if (!raw) {
            return [];
        }

        // 分割字符串
        const splitResult = raw.split(separatorRegex);

        // 手动 trim 每个元素
        const trimmed = [];
        for (let i = 0; i < splitResult.length; i++) {
            try {
                trimmed.push(splitResult[i].trim());
            } catch (e) {
                trimmed.push(String(splitResult[i]));
            }
        }

        // 手动过滤空字符串，避免使用被篡改的 Array.prototype.filter
        const filtered = [];
        for (let i = 0; i < trimmed.length; i++) {
            try {
                const v = '' + trimmed[i];
                if (v && v.length > 0) {
                    filtered.push(v);
                }
            } catch (e) {
                // 忽略无法处理的项
            }
        }

        return filtered;
    }

    /**
     * 判断输入是否为课程号（纯数字）
     * @param {string} input - 用户输入
     * @returns {boolean} - 是否为课程号
     */
    function isCourseCode(input) {
        return /^\d+$/.test(String(input).trim());
    }

    /**
     * 从教学班名称中提取课程名称
     * 教学班名称格式：课程名称-0001
     * @param {string} jxbmc - 教学班名称
     * @returns {string} - 课程名称
     */
    function extractCourseNameFromJxbmc(jxbmc) {
        if (!jxbmc) return '';
        // 移除末尾的 -数字 部分
        const match = jxbmc.match(/^(.+)-\d+$/);
        return match ? match[1].trim() : jxbmc.trim();
    }

    /**
     * 展开课程详情（支持课程号和课程名称）
     * @param {string} courseCodeOrName - 课程号或课程名称
     * @returns {boolean} - 是否成功展开
     */
    function expandCourseByCode(courseCodeOrName) {
        // 找所有课程头
        const heads = document.querySelectorAll('.panel-heading.kc_head');
        const input = String(courseCodeOrName).trim();
        const isCode = isCourseCode(input);

        for (let head of heads) {
            const panel = head.closest('.panel');
            let matched = panel ? matchesCoursePanel(panel, courseCodeOrName) : false;

            if (!matched && isCode) {
                // 按课程号匹配
                const codeInput = head.querySelector('input[name="kch_id"]');
                if (codeInput && codeInput.value === input) {
                    matched = true;
                }
            } else if (!matched) {
                // 按课程名称匹配
                // 课程名称在 span.kcmc 下的 <a> 标签内，格式：(课程号)课程名称
                const kcmcSpan = head.querySelector('span.kcmc');
                if (kcmcSpan) {
                    const kcmcLink = kcmcSpan.querySelector('a');
                    if (kcmcLink) {
                        const courseName = kcmcLink.textContent.trim();
                        // 宽松匹配：只要a元素内容包含用户输入就匹配（不区分大小写）
                        if (courseName.toLowerCase().includes(input.toLowerCase())) {
                            matched = true;
                        }
                    }
                }
            }
            /*
                                <div class="panel-heading kc_head" onclick="loadJxbxxZzxk(this)"
                                    style="background-color:#C1FFC1;">
                                    <h3 class="panel-title"><span class="kcmc" id="kcmc_23005523">(23005523)<a
                                                href="javascript:void(0);"
                                                onclick="showCourseInfo('23005523')">质量管理</a><i class="l-kc-xf"
                                                style="display: inline;"> - <i id="xf_23005523">5.0</i>
                                                学分</i></span><span>教学班个数：<font class="jxbgsxx">4</font></span><span
                                            id="zt_txt_23005523">状态：<b>已选</b></span></h3><input type="hidden"
                                        name="kch_id" value="23005523"><input type="hidden" name="kcxzzt"
                                        id="kcxzzt_23005523" value="1"><input type="hidden" name="cxbj"
                                        id="cxbj_23005523" value="0"><input type="hidden" name="fxbj" id="fxbj_23005523"
                                        value="0"><input type="hidden" name="xxkbj" id="xxkbj_23005523" value="0"><input
                                        type="hidden" name="czzt" value="0"><a href="javascript:void(0);"
                                        class="expand_close expand1">展开关闭</a>
                                </div>
            */

            if (matched) {
                const body = panel?.querySelector('.panel-body');
                if (!body || window.getComputedStyle(body).display === 'none') {
                    head.click();
                }
                return true;
            }
        }
        return false;
    }

    function forceExpandTargetCourses() {
        const targets = new Set([
            ...activeCourses,
            ...TARGET_COURSES.map(c => typeof c === 'string' ? c : c.code)
        ]);

        targets.forEach(code => {
            expandCourseByCode(code);
        });
    }

    function forceExpandTargetCoursesAggressive() {
        let count = 0;
        const timer = setInterval(() => {
            forceExpandTargetCourses();
            if (++count >= 3) clearInterval(timer);
        }, 300);
    }

    // 彩色日志函数
    function log(message, type = 'info', courseCode = null) {
        const timestamp = new Date().toLocaleTimeString();
        const courseTag = courseCode ? `[${courseCode}]` : '';
        const prefix = `[抢课脚本 ${timestamp}]${courseTag}`;

        switch (type) {
            case 'success':
                console.log(`%c${prefix} ✅ ${message}`, 'color: #00ff00; font-weight: bold;');
                break;
            case 'error':
                console.log(`%c${prefix} ❌ ${message}`, 'color: #ff0000; font-weight: bold;');
                break;
            case 'warning':
                console.log(`%c${prefix} ⚠️ ${message}`, 'color: #ffa500; font-weight: bold;');
                break;
            case 'info':
                console.log(`%c${prefix} ℹ️ ${message}`, 'color: #0099ff;');
                break;
        }

        // 内部调用使用词法作用域中的 log；这里直接同步到面板，避免只显示在控制台。
        addUILog(type, courseTag + message);
    }

    // 初始化课程状态
    function initCourseState(courseCode) {
        if (!courseStates.has(courseCode)) {
            courseStates.set(courseCode, {
                attempts: 0,
                failed: 0,
                tried: new Set(),
                conflicted: new Set(),
                selecting: false,
                success: false,
                lastAttempt: 0,
                lastSearchAt: 0
            });
        }
        return courseStates.get(courseCode);
    }

    // 获取课程状态
    function getCourseState(courseCode) {
        return courseStates.get(courseCode) || initCourseState(courseCode);
    }

    // 检查是否所有课程都已完成（成功或失败）
    function allCoursesCompleted() {
        for (let courseCode of activeCourses) {
            const state = getCourseState(courseCode);
            if (!state.success && state.failed < MAX_FAILED_ATTEMPTS) {
                return false;
            }
        }
        return true;
    }

    // 时间模糊匹配函数
    function matchesTimeFilter(timeInfo, timeFilter) {
        // 如果没有配置过滤器，返回true（不过滤）
        if (!timeFilter || timeFilter.length === 0) {
            return true;
        }

        // 如果时间信息为空，返回false
        if (!timeInfo || timeInfo === '未知时间') {
            return false;
        }

        // 检查是否匹配任意一个时间关键词
        for (let keyword of timeFilter) {
            if (timeInfo.includes(keyword)) {
                return true;
            }
        }

        return false;
    }

    // 教师模糊匹配函数
    function matchesTeacherFilter(teacher, teacherFilter) {
        // 如果没有配置过滤器，返回true（不过滤）
        if (!teacherFilter || teacherFilter.length === 0) {
            return true;
        }

        // 如果教师信息为空，返回false
        if (!teacher || teacher === '未知教师') {
            return false;
        }

        // 检查是否匹配任意一个教师关键词
        for (let keyword of teacherFilter) {
            if (teacher.includes(keyword)) {
                return true;
            }
        }

        return false;
    }

    // 检查教学班是否匹配过滤条件
    function matchesFilters(teachingClass, courseCode) {
        // 获取该课程的配置
        const courseConfig = TARGET_COURSES.find(c => c.code === courseCode);

        // 获取时间和教师过滤器（优先使用课程特定配置，否则使用全局配置）
        const timeFilter = (courseConfig && courseConfig.timeFilter) || GLOBAL_TIME_FILTER;
        const teacherFilter = (courseConfig && courseConfig.teacherFilter) || GLOBAL_TEACHER_FILTER;

        // 检查时间过滤
        const timeMatch = matchesTimeFilter(teachingClass.info.timeInfo, timeFilter);
        if (!timeMatch) {
            return { match: false, reason: '时间不匹配过滤条件' };
        }

        // 检查教师过滤
        const teacherMatch = matchesTeacherFilter(teachingClass.info.teacher, teacherFilter);
        if (!teacherMatch) {
            return { match: false, reason: '教师不匹配过滤条件' };
        }

        return { match: true, reason: '通过过滤' };
    }

    function normalizeCourseText(value) {
        return String(value || '')
            .replace(/\s+/g, '')
            .replace(/[（）]/g, match => match === '（' ? '(' : ')')
            .toLowerCase();
    }

    function getCoursePanelMeta(panel) {
        const title = panel.querySelector('.kc_head .kcmc');
        const titleText = title ? title.textContent.trim() : '';
        const visibleCode = titleText.match(/^[（(]\s*([^）)]+?)\s*[）)]/);
        const internalCode = panel.querySelector('.kc_head input[name="kch_id"]');
        const nameLink = panel.querySelector('.kc_head .kcmc a');

        return {
            code: visibleCode ? visibleCode[1].trim() : '',
            internalCode: internalCode ? internalCode.value.trim() : '',
            name: nameLink ? nameLink.textContent.trim() : '',
            titleText
        };
    }

    function matchesCoursePanel(panel, targetCourseCodeOrName) {
        const input = normalizeCourseText(targetCourseCodeOrName);
        const meta = getCoursePanelMeta(panel);

        if (isCourseCode(input)) {
            return normalizeCourseText(meta.code) === input ||
                normalizeCourseText(meta.internalCode) === input;
        }

        return normalizeCourseText(meta.name).includes(input) ||
            normalizeCourseText(meta.titleText).includes(input);
    }

    // 教学班行没有课程名称；课程名称和可见课程号位于所属课程面板的标题中。
    function isRowMatchingCourse(row, targetCourseCodeOrName) {
        const input = normalizeCourseText(targetCourseCodeOrName);
        const coursePanel = row.closest('.panel.panel-info');

        if (coursePanel && matchesCoursePanel(coursePanel, targetCourseCodeOrName)) {
            return true;
        }

        const courseCodeCell = row.querySelector('td.kch_id');
        if (isCourseCode(input) && courseCodeCell && normalizeCourseText(courseCodeCell.textContent) === input) {
            return true;
        }

        const classNameCell = row.querySelector('.jxbmc, td.jxbmc');
        return Boolean(classNameCell && normalizeCourseText(classNameCell.textContent).includes(input));
    }

    // 查找目标课程面板下的所有教学班，课程名称按标题匹配，课程号同时支持页面显示号和内部号。
    function findAllTeachingClasses(targetCourseCodeOrName) {
        const teachingClasses = [];
        const panels = document.querySelectorAll('.panel.panel-info');

        const appendRows = (rows) => {
            for (const row of rows) {
                const selectButton = row.querySelector('button, a, input[type="button"]');
                if (!selectButton) {
                    continue;
                }

                const classInfo = extractTeachingClassInfo(row);
                if (classInfo && classInfo.id) {
                    teachingClasses.push({
                        row,
                        info: classInfo,
                        button: selectButton,
                        courseCode: targetCourseCodeOrName
                    });
                }
            }
        };

        for (const panel of panels) {
            if (matchesCoursePanel(panel, targetCourseCodeOrName)) {
                appendRows(panel.querySelectorAll('table tbody tr.body_tr'));
            }
        }

        // 兼容教学班行脱离课程面板的旧页面结构。
        if (teachingClasses.length === 0) {
            const matchingRows = [];
            const rows = document.querySelectorAll('table tbody tr.body_tr');
            for (let i = 0; i < rows.length; i++) {
                if (isRowMatchingCourse(rows[i], targetCourseCodeOrName)) {
                    matchingRows.push(rows[i]);
                }
            }
            appendRows(matchingRows);
        }

        log(`找到 ${teachingClasses.length} 个教学班`, 'info', targetCourseCodeOrName);
        return teachingClasses;
    }

    // 查找所有目标课程的教学班
    function findAllCoursesTeachingClasses() {
        const allClasses = new Map(); // courseCode -> teachingClasses[]

        for (let courseCode of activeCourses) {
            const classes = findAllTeachingClasses(courseCode);
            if (classes.length > 0) {
                allClasses.set(courseCode, classes);
            }
        }

        return allClasses;
    }

    // 提取教学班信息
    function extractTeachingClassInfo(row) {
        try {
            let className = '';
            let teacher = '';
            let capacity = '';
            let timeInfo = '';

            // 记录原始文本用于调试
            const fullText = row.textContent || row.innerText || '';

            // 优先使用表格特定类名提取信息（更准确）
            // .jxbmc - 教学班名称
            const jxbmcEl = row.querySelector('.jxbmc, td.jxbmc');
            if (jxbmcEl) {
                className = jxbmcEl.textContent.trim();
            }

            // .jsxmzc - 上课教师（格式：【教师名】职称）
            const jsxmzcEl = row.querySelector('.jsxmzc, td.jsxmzc');
            if (jsxmzcEl) {
                teacher = jsxmzcEl.textContent.trim();
            }

            // .sksj - 上课时间
            const sksjEl = row.querySelector('.sksj, td.sksj');
            if (sksjEl) {
                timeInfo = sksjEl.textContent.trim();
            }

            // .rsxx - 已选/容量（格式：【36/50】）
            const rsxxEl = row.querySelector('.rsxx, td.rsxx');
            if (rsxxEl) {
                capacity = rsxxEl.textContent.trim();
            }

            // 如果通过类名没找到，回退到遍历所有单元格
            if (!className || !teacher || !capacity || !timeInfo) {
                const cells = row.querySelectorAll('td');
                for (let cell of cells) {
                    const text = cell.textContent.trim();

                    // 提取教学班名称（如：工程化学-0001）
                    if (!className && text.includes('-') && text.match(/\d{4}/)) {
                        className = text;
                    }

                    // 提取教师信息
                    if (!teacher && text.includes('【') && text.includes('】')) {
                        teacher = text;
                    }

                    // 提取容量信息 - 只选择数字/数字格式
                    if (!capacity && text.match(/\d+\/\d+/)) {
                        capacity = text;
                    }

                    // 提取时间信息
                    if (!timeInfo && (text.includes('星期') || text.includes('第') || text.includes('节'))) {
                        timeInfo = text;
                    }
                }
            }

            // 如果仍未找到基本信息，尝试从整个行文本中提取
            if (!className || !teacher || !capacity) {
                // 尝试提取教学班名称
                if (!className) {
                    const classMatch = fullText.match(/([^-\s]+[-]\d{4})/);
                    if (classMatch) {
                        className = classMatch[1];
                    }
                }

                // 尝试提取教师
                if (!teacher) {
                    const teacherMatch = fullText.match(/【([^】]+)】/);
                    if (teacherMatch) {
                        teacher = `【${teacherMatch[1]}】`;
                    }
                }

                // 尝试提取容量
                if (!capacity) {
                    const capacityMatch = fullText.match(/(\d+\/\d+|已满)/);
                    if (capacityMatch) {
                        capacity = capacityMatch[1];
                    }
                }

                // 尝试提取时间
                if (!timeInfo) {
                    const timeMatch = fullText.match(/(星期[一二三四五六日][^星期]*)/g);
                    if (timeMatch) {
                        timeInfo = timeMatch.join(' ');
                    }
                }
            }

            // 更宽松的信息检查 - 只要有按钮就认为是有效的教学班
            const hasButton = row.querySelector('button, a, input[type="button"]') !== null;

            // 生成唯一ID（优先使用 jxb_id）
            const jxbIdEl = row.querySelector('.jxb_id, div.jxb_id');
            const jxbId = jxbIdEl ? jxbIdEl.textContent.trim() : '';
            const uniqueId = jxbId || className || teacher || capacity || fullText.substring(0, 20) || `row_${Date.now()}_${Math.random()}`;

            const result = {
                className: className || '未知教学班',
                teacher: teacher || '未知教师',
                capacity: capacity || '未知容量',
                timeInfo: timeInfo || '未知时间',
                id: `${uniqueId}_${teacher || 'unknown'}`,
                jxbId: jxbId, // 保存教学班ID，可能用于后续操作
                hasButton: hasButton,
                rawText: fullText.substring(0, 200) // 保留原始文本用于调试
            };

            return result;

        } catch (error) {
            // 返回默认信息而不是null
            return {
                className: '解析失败',
                teacher: '未知教师',
                capacity: '未知容量',
                timeInfo: '未知时间',
                id: `error_${Date.now()}_${Math.random()}`,
                jxbId: '',
                hasButton: false,
                rawText: (row.textContent || '').substring(0, 200)
            };
        }
    }

    function isVisibleElement(element) {
        const style = window.getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
    }

    // 选课轮次可能允许超出显示容量，页面的可用选课控件才是提交资格的依据。
    function getTeachingClassSelectionAction(row) {
        const elements = row.querySelectorAll('button, a, input[type="button"], input[type="submit"]');
        for (let i = 0; i < elements.length; i++) {
            const element = elements[i];
            const action = (element.getAttribute('onclick') || '').toLowerCase();
            const label = (element.innerText || element.value || '').trim();

            if (action.includes('choosecoursezzxk') || action.includes('xuanke') || label === '选课') {
                return element;
            }
        }
        return null;
    }

    function isTeachingClassSelectable(teachingClass) {
        const action = getTeachingClassSelectionAction(teachingClass.row);
        return Boolean(
            action &&
            isVisibleElement(action) &&
            !action.disabled &&
            action.getAttribute('aria-disabled') !== 'true' &&
            !action.classList.contains('disabled')
        );
    }

    function getVisibleSelectionDialogs() {
        const dialogs = document.querySelectorAll('.modal, .dialog, .bootbox, [role="dialog"], [role="alert"]');
        const visibleDialogs = [];
        for (let i = 0; i < dialogs.length; i++) {
            if (isVisibleElement(dialogs[i])) {
                visibleDialogs.push(dialogs[i]);
            }
        }
        return visibleDialogs;
    }

    function getDialogText(dialog) {
        return (dialog.innerText || dialog.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function isTimeConflictText(text) {
        const keywords = [
            '所选教学班的上课时间与其他教学班有冲突',
            '上课时间与其他教学班有冲突',
            '时间冲突',
            '时间有冲突'
        ];
        for (let i = 0; i < keywords.length; i++) {
            if (text.includes(keywords[i])) {
                return true;
            }
        }
        return false;
    }

    function isCapacityFailureText(text) {
        const keywords = [
            '无余量',
            '没有余量',
            '余量不足',
            '容量已满',
            '人数已满',
            '容量超出',
            '已满'
        ];
        for (let i = 0; i < keywords.length; i++) {
            if (text.includes(keywords[i])) {
                return true;
            }
        }
        return false;
    }

    function closeSelectionDialog(dialog) {
        const buttons = dialog.querySelectorAll('button, input[type="button"], a');
        let button = null;
        for (let i = 0; i < buttons.length; i++) {
            const text = (buttons[i].innerText || buttons[i].value || '').trim();
            if (isVisibleElement(buttons[i]) && /确定|确认|关闭|取消|知道/.test(text)) {
                button = buttons[i];
                break;
            }
        }
        if (button) {
            button.click();
        } else if (dialog.id && window.jQuery && typeof window.jQuery.closeModal === 'function') {
            window.jQuery.closeModal(dialog.id);
        }
    }

    function getCompositeSelectionDialog() {
        const dialogs = getVisibleSelectionDialogs();
        for (let i = 0; i < dialogs.length; i++) {
            const dialog = dialogs[i];
            if (dialog.id === 'addModal' && dialog.querySelector('#ajaxForm') && getDialogText(dialog).includes('选子课程')) {
                return dialog;
            }
        }
        return null;
    }

    function findChangedSelectionDialog(dialogsBefore, ignoredId) {
        const dialogs = getVisibleSelectionDialogs();
        for (let i = 0; i < dialogs.length; i++) {
            const dialog = dialogs[i];
            if (ignoredId && dialog.id === ignoredId) {
                continue;
            }

            const text = getDialogText(dialog);
            if (!dialogsBefore.has(dialog) || dialogsBefore.get(dialog) !== text) {
                return dialog;
            }
        }
        return null;
    }

    function prepareCompositeSelection(dialog) {
        const xsdmInputs = dialog.querySelectorAll("input[name='current_xsdm']");
        if (xsdmInputs.length === 0) {
            return { status: 'pending' };
        }

        let waitingForRows = false;
        let missingCapacity = false;

        for (let i = 0; i < xsdmInputs.length; i++) {
            const xsdm = xsdmInputs[i].value.trim();
            const selectedInput = dialog.querySelector(`[id="select_jxb_${xsdm}"]`);
            if (selectedInput && selectedInput.value.trim() !== '') {
                continue;
            }

            const table = dialog.querySelector(`[id="table_${xsdm}"]`);
            if (!table) {
                waitingForRows = true;
                continue;
            }

            const rows = table.querySelectorAll('tbody tr');
            if (rows.length === 0) {
                waitingForRows = true;
                continue;
            }

            let hasSelectableRow = false;
            let selectedRow = false;
            for (let j = 0; j < rows.length; j++) {
                const row = rows[j];
                const button = row.querySelector('button[onclick*="xuanke"]');
                if (!button) {
                    continue;
                }

                hasSelectableRow = true;
                if (isTeachingClassSelectable({ row })) {
                    button.click();
                    selectedRow = true;
                    break;
                }
            }

            if (!selectedRow) {
                if (hasSelectableRow) {
                    missingCapacity = true;
                } else {
                    waitingForRows = true;
                }
            }
        }

        if (missingCapacity) {
            return { status: 'capacity' };
        }

        if (waitingForRows) {
            return { status: 'pending' };
        }

        for (let i = 0; i < xsdmInputs.length; i++) {
            const xsdm = xsdmInputs[i].value.trim();
            const selectedInput = dialog.querySelector(`[id="select_jxb_${xsdm}"]`);
            if (!selectedInput || selectedInput.value.trim() === '') {
                return { status: 'pending' };
            }
        }

        return { status: 'ready' };
    }

    function cancelCompositeSelection(dialog) {
        const cancelButton = dialog.querySelector('#btn_cancel');
        if (cancelButton && isVisibleElement(cancelButton)) {
            cancelButton.click();
            return;
        }

        const closeButton = dialog.querySelector('.bootbox-close, .bootbox-close-button');
        if (closeButton && isVisibleElement(closeButton)) {
            closeButton.click();
        }
    }

    function clickCompositeSelectionConfirm(dialog) {
        const confirmButton = dialog.querySelector('#btn_success');
        if (confirmButton && isVisibleElement(confirmButton)) {
            confirmButton.click();
            return true;
        }
        return false;
    }

    function clickIntermediateConfirm(dialog) {
        const buttons = dialog.querySelectorAll('button, input[type="button"], a');
        for (let i = 0; i < buttons.length; i++) {
            const button = buttons[i];
            const text = (button.innerText || button.value || '').trim();
            const handler = button.getAttribute('data-bb-handler') || '';
            if (!isVisibleElement(button)) {
                continue;
            }
            if (handler === 'success' || handler === 'ok' || handler === 'confirm' || /确定|确认|继续/.test(text)) {
                button.click();
                return true;
            }
        }
        return false;
    }

    function isContinuationConfirmation(dialog, text) {
        if (dialog.id === 'alertModal' || isTimeConflictText(text)) {
            return false;
        }

        return dialog.id === 'confirmModal' || /确认选课|确认继续|确定要选|是否继续选|继续选课/.test(text);
    }

    function checkTimeConflictWarning() {
        const dialogs = getVisibleSelectionDialogs();
        for (let i = 0; i < dialogs.length; i++) {
            if (isTimeConflictText(getDialogText(dialogs[i]))) {
                return true;
            }
        }
        return false;
    }

    function getNativeSelectButton(row) {
        return row.querySelector('button[onclick*="chooseCourseZzxk"], a[onclick*="chooseCourseZzxk"], input[onclick*="chooseCourseZzxk"]') ||
            getTeachingClassSelectionAction(row);
    }

    function isTeachingClassSelected(teachingClass) {
        const row = teachingClass.row;
        return Boolean(row && (
            row.querySelector('[onclick*="cancelCourseZzxk"]') ||
            row.querySelector('input[name="hidsfxz"][value="1"]') ||
            row.querySelector('.an')?.textContent.includes('已选') ||
            row.textContent.includes('退选')
        ));
    }

    function markCourseSelected(courseCode, teachingClass) {
        const state = getCourseState(courseCode);
        state.failed = 0;
        state.selecting = false;
        state.success = true;
        selectedCourses.add(courseCode);
        activeCourses.delete(courseCode);
        log(`🎊 确认选课成功: ${teachingClass.info.className}！`, 'success', courseCode);

        if (window.Notification && Notification.permission === 'granted') {
            new Notification('抢课成功！', {
                body: `成功选择: ${courseCode} - ${teachingClass.info.className}`,
                icon: '/favicon.ico'
            });
        }

        if (activeCourses.size === 0) {
            alert(`🎉 所有课程抢课完成！\n成功课程: ${Array.from(selectedCourses).join(', ')}`);
            stopGrabbing();
        }
    }

    function syncSelectedCourse(courseCode, teachingClasses) {
        const selectedClass = teachingClasses.find(isTeachingClassSelected);
        if (!selectedClass) {
            return false;
        }

        const state = getCourseState(courseCode);
        state.failed = 0;
        state.selecting = false;
        state.success = true;
        selectedCourses.add(courseCode);
        activeCourses.delete(courseCode);
        log(`课程当前已选: ${selectedClass.info.className}`, 'success', courseCode);
        return true;
    }

    // 退选指定课程
    function dropCourse(courseCode) {
        return new Promise((resolve) => {
            try {
                log(`🔄 开始退选课程: ${courseCode}`, 'info', courseCode);

                // 查找该课程的所有教学班
                const teachingClasses = findAllTeachingClasses(courseCode);

                if (teachingClasses.length === 0) {
                    log(`未找到课程 ${courseCode} 的教学班`, 'warning', courseCode);
                    resolve(false);
                    return;
                }

                // 查找包含"退选"按钮的教学班
                let dropClass = null;
                for (let tc of teachingClasses) {
                    const rowText = tc.row ? tc.row.textContent : '';
                    if (rowText.includes('退选')) {
                        dropClass = tc;
                        break;
                    }
                }

                if (!dropClass) {
                    log(`课程 ${courseCode} 未找到可退选的教学班`, 'warning', courseCode);
                    resolve(false);
                    return;
                }

                // 查找退选按钮
                const row = dropClass.row;
                const allElements = row.querySelectorAll('*');
                let dropButton = null;

                for (let element of allElements) {
                    const elementText = element.textContent.trim();
                    if (elementText === '退选' || elementText.includes('退选')) {
                        if (element.tagName === 'BUTTON' || element.tagName === 'A' || element.onclick || element.getAttribute('onclick')) {
                            dropButton = element;
                            break;
                        }
                    }
                }

                if (!dropButton) {
                    log(`未找到课程 ${courseCode} 的退选按钮`, 'warning', courseCode);
                    resolve(false);
                    return;
                }

                log(`找到退选按钮，正在点击...`, 'info', courseCode);
                dropButton.click();

                // 等待模态框出现并确认退选
                setTimeout(() => {
                    log(`等待退选确认模态框...`, 'info', courseCode);

                    // 多种方式查找模态框中的确定按钮
                    let confirmButton = null;

                    // 方法1: 查找模态框内的确定按钮（优先）
                    const modals = document.querySelectorAll('.modal, .bootbox, [role="dialog"]');
                    for (let modal of modals) {
                        // 检查模态框是否包含退选相关文本
                        const modalText = modal.textContent || '';
                        if (modalText.includes('退选') || modalText.includes('你是否')) {
                            // 在这个模态框内查找确定按钮
                            const buttons = modal.querySelectorAll('button, input[type="button"], a');
                            for (let btn of buttons) {
                                const btnText = btn.textContent.trim();
                                const btnId = btn.id || '';
                                const btnHandler = btn.getAttribute('data-bb-handler') || '';

                                // 匹配确定按钮的多种特征
                                if (btnText.includes('确定') || btnText.includes('确认') ||
                                    btnText.includes('OK') || btnId === 'btn_ok' ||
                                    btnHandler === 'ok' || btnHandler === 'confirm') {
                                    confirmButton = btn;
                                    log(`✅ 找到模态框确定按钮 (${btnText || btnId})`, 'info', courseCode);
                                    break;
                                }
                            }
                            if (confirmButton) break;
                        }
                    }

                    // 方法2: 直接查找带有特定ID的确定按钮
                    if (!confirmButton) {
                        confirmButton = document.querySelector('#btn_ok, button[data-bb-handler="ok"], button[data-bb-handler="confirm"]');
                        if (confirmButton) {
                            log(`✅ 通过ID找到确定按钮`, 'info', courseCode);
                        }
                    }

                    // 方法3: 查找所有可见的确定按钮（最后备选）
                    if (!confirmButton) {
                        const allButtons = document.querySelectorAll('button, input[type="button"], a.btn');
                        for (let btn of allButtons) {
                            const text = btn.textContent.trim();
                            // 检查按钮是否可见
                            const style = window.getComputedStyle(btn);
                            const isVisible = style.display !== 'none' && style.visibility !== 'hidden' && btn.offsetParent !== null;

                            if (isVisible && (text === '确定' || text === '确  定' || text.includes('确定'))) {
                                confirmButton = btn;
                                log(`✅ 找到可见的确定按钮`, 'info', courseCode);
                                break;
                            }
                        }
                    }

                    if (confirmButton) {
                        log(`正在点击确定按钮...`, 'info', courseCode);
                        confirmButton.click();

                        // 等待退选操作完成
                        setTimeout(() => {
                            log(`✅ 已确认退选课程 ${courseCode}`, 'success', courseCode);
                            resolve(true);
                        }, 1500);
                    } else {
                        log(`❌ 未找到退选确认按钮`, 'error', courseCode);
                        resolve(false);
                    }
                }, 800); // 增加等待时间，确保模态框完全加载

            } catch (error) {
                log(`退选课程失败: ${error.message}`, 'error', courseCode);
                resolve(false);
            }
        });
    }

    // 尝试选择教学班
    function selectTeachingClass(teachingClass) {
        if (!teachingClass || !teachingClass.row) return false;

        const courseCode = teachingClass.courseCode;
        const classId = teachingClass.info.id;
        const state = getCourseState(courseCode);

        // 检查是否已经因时间冲突被跳过
        if (state.conflicted.has(classId)) {
            log(`教学班 ${teachingClass.info.className} 已知时间冲突，跳过`, 'warning', courseCode);
            return false;
        }

        log(`尝试选择教学班: ${teachingClass.info.className} (${teachingClass.info.teacher})`, 'info', courseCode);
        log(`时间: ${teachingClass.info.timeInfo}`, 'info', courseCode);
        log(`容量: ${teachingClass.info.capacity}`, 'info', courseCode);

        const row = teachingClass.row;
        const selectElement = getNativeSelectButton(row);
        if (!selectElement) {
            log('未找到页面原生选课按钮', 'warning', courseCode);
            state.selecting = false;
            return false;
        }

        state.selecting = true;
        state.tried.add(classId);
        const dialogsBefore = new Map(getVisibleSelectionDialogs().map(dialog => [dialog, getDialogText(dialog)]));
        let compositeConfirmClicked = false;

        log('找到页面原生选课按钮，正在点击...', 'info', courseCode);
        selectElement.click();

        const startedAt = Date.now();
        const pollResult = () => {
            const currentRow = teachingClass.info.jxbId
                ? document.getElementById(`tr_${teachingClass.info.jxbId}`) || row
                : row;
            const currentClass = { ...teachingClass, row: currentRow };

            if (isTeachingClassSelected(currentClass)) {
                markCourseSelected(courseCode, currentClass);
                return;
            }

            const compositeDialog = getCompositeSelectionDialog();
            if (compositeDialog && !compositeConfirmClicked) {
                const compositeState = prepareCompositeSelection(compositeDialog);
                if (compositeState.status === 'ready') {
                    log('子教学班已选定，正在提交父子教学班选择...', 'info', courseCode);
                    if (clickCompositeSelectionConfirm(compositeDialog)) {
                        compositeConfirmClicked = true;
                        log('已提交父子教学班选择，等待系统响应...', 'info', courseCode);
                        setTimeout(pollResult, 100);
                        return;
                    }

                    if (Date.now() - startedAt < 5000) {
                        setTimeout(pollResult, 150);
                        return;
                    }
                } else if (compositeState.status === 'capacity') {
                    cancelCompositeSelection(compositeDialog);
                    state.tried.delete(classId);
                    state.selecting = false;
                    state.failed = 0;
                    log(`⚡ 教学班 ${teachingClass.info.className} 的子教学班暂无余量，继续等待`, 'warning', courseCode);
                    return;
                } else if (Date.now() - startedAt < 5000) {
                    setTimeout(pollResult, 150);
                    return;
                } else {
                    cancelCompositeSelection(compositeDialog);
                    state.tried.delete(classId);
                    state.failed++;
                    state.selecting = false;
                    log(`⚠️ 子教学班信息未加载完成，准备重试 (累计失败次数: ${state.failed})`, 'warning', courseCode);
                    return;
                }
            }

            const dialog = findChangedSelectionDialog(
                dialogsBefore,
                compositeConfirmClicked ? 'addModal' : null
            );

            if (dialog) {
                const dialogText = getDialogText(dialog);

                if (isContinuationConfirmation(dialog, dialogText) && clickIntermediateConfirm(dialog)) {
                    state.tried.add(classId);
                    state.selecting = true;
                    setTimeout(pollResult, 100);
                    return;
                }

                if (isTimeConflictText(dialogText)) {
                    closeSelectionDialog(dialog);
                    if (compositeConfirmClicked && compositeDialog) {
                        cancelCompositeSelection(compositeDialog);
                    }
                    state.conflicted.add(classId);
                    state.tried.delete(classId);
                    state.selecting = false;
                    log(`🛑 教学班 ${teachingClass.info.className} 时间冲突，已跳过该教学班`, 'error', courseCode);
                    return;
                }

                state.tried.delete(classId);
                state.selecting = false;
                if (isCapacityFailureText(dialogText)) {
                    closeSelectionDialog(dialog);
                    state.failed = 0;
                    log(`⚡ 教学班 ${teachingClass.info.className} 已被其他人抢先，继续等待余量`, 'warning', courseCode);
                } else if (clickIntermediateConfirm(dialog)) {
                    state.tried.add(classId);
                    state.selecting = true;
                    setTimeout(pollResult, 100);
                    return;
                } else {
                    closeSelectionDialog(dialog);
                    state.failed++;
                    log(`⚠️ 选课失败: ${dialogText} (累计失败次数: ${state.failed})`, 'warning', courseCode);
                }
                return;
            }

            if (Date.now() - startedAt < 5000) {
                setTimeout(pollResult, 150);
                return;
            }

            state.tried.delete(classId);
            state.failed++;
            state.selecting = false;
            log(`⚠️ 选课请求未确认成功，准备重试 (累计失败次数: ${state.failed})`, 'warning', courseCode);
        };

        setTimeout(pollResult, 100);
        return true;
    }

    function setCourseSearchValue(searchText) {
        const searchInput = document.querySelector('input[name="searchInput"]');
        if (!searchInput || !searchText || searchInput.value === searchText) {
            return;
        }

        const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        valueSetter.call(searchInput, searchText);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 使用教务系统实际的查询控件刷新课程列表。
    function refreshCourseList(searchText = '') {
        try {
            // 全局节流：避免重复实例/重复触发导致的“刷新触发两次”
            const now = Date.now();
            const last = __CG_GLOBAL__[__CG_REFRESH_LOCK_KEY__] || 0;
            if (now - last < 300) {
                return;
            }
            __CG_GLOBAL__[__CG_REFRESH_LOCK_KEY__] = now;

            setCourseSearchValue(searchText);

            const searchBtn = document.querySelector('button[name="query"]') || document.querySelector(
                'button[onclick*="search"], input[value*="搜索"], input[value*="查询"]'
            );
            if (searchBtn) {
                searchBtn.click();
                log(searchText ? `已查询课程: ${searchText}` : '已触发课程列表刷新');
            } else {
                if (typeof jQuery !== 'undefined' && jQuery('input[name="searchInput"]').length) {
                    jQuery('input[name="searchInput"]').trigger('searchResult');
                    log('已触发课程查询事件');
                }
            }

            // 🔥 刷新后强制恢复展开
            if (click2expend_enabled && CLICK2EXPEND_ENABLED) setTimeout(forceExpandTargetCoursesAggressive, 600);
        } catch (e) {
            log(`刷新课程列表失败: ${e.message}`, 'warning');
        }
    }

    // 单个课程抢课逻辑
    function attemptGrabSingleCourse(courseCode) {
        const state = getCourseState(courseCode);

        // 检查是否正在选课
        if (state.selecting) {
            return;
        }

        // 检查是否已成功
        if (state.success) {
            return;
        }

        state.attempts++;

        // 查找所有教学班
        const teachingClasses = findAllTeachingClasses(courseCode);
        if (teachingClasses.length === 0) {
            if (Date.now() - state.lastSearchAt >= 2000) {
                state.lastSearchAt = Date.now();
                refreshCourseList(courseCode);
                log('当前列表没有该课程，已发起页面查询，等待结果更新', 'info', courseCode);
            }
            if (click2expend_enabled && CLICK2EXPEND_ENABLED) forceExpandTargetCoursesAggressive();
            return;
        }

        if (syncSelectedCourse(courseCode, teachingClasses)) {
            if (activeCourses.size === 0) {
                stopGrabbing();
            }
            return;
        }

        // 设置标志：是否有时间不冲突但人数已满的教学班
        let hasNonConflictedFullClass = false;

        // 逐个尝试所有教学班
        for (let tc of teachingClasses) {
            // 确保教学班信息完整
            if (!tc || !tc.info || !tc.info.id) {
                continue;
            }

            const classId = tc.info.id;

            // 检查是否已经因时间冲突被标记
            if (state.conflicted.has(classId)) {
                continue;
            }

            // 检查是否已经尝试过
            if (state.tried.has(classId)) {
                continue;
            }

            // 检查是否有选课按钮（排除退选按钮）
            const rowText = tc.row ? tc.row.textContent : '';
            if (rowText.includes('退选')) {
                continue;
            }

            if (!rowText.includes('选课')) {
                continue;
            }

            // ========== 应用过滤器 ==========
            const filterResult = matchesFilters(tc, courseCode);

            // 调试日志：显示过滤器配置和匹配结果
            const courseConfig = TARGET_COURSES.find(c => c.code === courseCode);
            if (courseConfig && (courseConfig.timeFilter || courseConfig.teacherFilter)) {
                log(`🔍 过滤器检查 - 教学班: ${tc.info.className}`, 'info', courseCode);
                if (courseConfig.timeFilter) {
                    log(`   时间过滤器: [${courseConfig.timeFilter.join(', ')}]`, 'info', courseCode);
                    log(`   教学班时间: ${tc.info.timeInfo}`, 'info', courseCode);
                }
                if (courseConfig.teacherFilter) {
                    log(`   教师过滤器: [${courseConfig.teacherFilter.join(', ')}]`, 'info', courseCode);
                    log(`   教学班教师: ${tc.info.teacher}`, 'info', courseCode);
                }
                log(`   匹配结果: ${filterResult.match ? '✅通过' : '❌' + filterResult.reason}`, 'info', courseCode);
            }

            if (!filterResult.match) {
                // 不满足过滤条件，跳过此教学班
                log(`⏭️ 跳过教学班 ${tc.info.className}: ${filterResult.reason}`, 'info', courseCode);
                log(`   教师: ${tc.info.teacher}, 时间: ${tc.info.timeInfo}`, 'info', courseCode);
                continue;
            }

            // 页面开放提交时立即尝试，兼容允许超容量选课的轮次。
            const canSubmitSelection = isTeachingClassSelectable(tc);

            if (canSubmitSelection) {
                log(`🎯 发现可提交选课的教学班: ${tc.info.className}`, 'success', courseCode);
                log(`📚 教师: ${tc.info.teacher}`, 'info', courseCode);
                log(`⏰ 时间: ${tc.info.timeInfo}`, 'info', courseCode);
                log(`👥 容量: ${tc.info.capacity}`, 'info', courseCode);

                // 获取课程配置
                const courseConfig = TARGET_COURSES.find(c => c.code === courseCode);

                // 如果配置了替换课程，先执行退选
                if (courseConfig && courseConfig.replaceCode) {
                    log(`🔄 检测到需要替换课程 ${courseConfig.replaceCode}，立即执行退选...`, 'warning', courseCode);
                    addUILog && addUILog('warning', `[${courseCode}] 🔄 发现空位！开始退选 ${courseConfig.replaceCode}`);

                    // 异步执行退选，然后选课
                    dropCourse(courseConfig.replaceCode).then(dropSuccess => {
                        if (dropSuccess) {
                            log(`✅ 退选成功，立即选择新课程 ${courseCode}`, 'success', courseCode);
                            addUILog && addUILog('success', `[${courseCode}] ✅ 退选成功，开始抢课...`);

                            // 等待页面更新后立即选课
                            setTimeout(() => {
                                selectTeachingClass(tc);
                            }, 1500);
                        } else {
                            log(`❌ 退选失败，放弃本次选课`, 'error', courseCode);
                            addUILog && addUILog('error', `[${courseCode}] ❌ 退选失败，等待下次机会`);
                            state.selecting = false;
                        }
                    });
                    return; // 等待异步退选完成
                } else {
                    // 没有配置替换课程，直接选课
                    const selectResult = selectTeachingClass(tc);
                    if (selectResult) {
                        return; // 尝试选课后等待结果
                    }
                }
            } else {
                hasNonConflictedFullClass = true;
            }
        }

        // 重置已尝试列表，继续轮询
        if (state.attempts % 10 === 0 && state.tried.size > 0) {
            state.tried.clear();
            log(`已重置尝试列表，继续监控`, 'info', courseCode);
        }
    }

    // 主抢课逻辑（多课程并发版）
    function attemptGrabCourse() {
        attemptCount++;

        if (attemptCount > MAX_ATTEMPTS) {
            log(`已达到最大尝试次数 ${MAX_ATTEMPTS}，停止抢课`, 'warning');
            stopGrabbing();
            return;
        }

        if (activeCourses.size === 0) {
            log('所有课程已完成', 'success');
            stopGrabbing();
            return;
        }

        log(`第 ${attemptCount} 次尝试抢课 (活跃课程: ${activeCourses.size})`);

        // 按优先级排序课程
        const sortedCourses = Array.from(activeCourses).sort((a, b) => {
            const courseA = TARGET_COURSES.find(c => c.code === a);
            const courseB = TARGET_COURSES.find(c => c.code === b);
            const priorityA = courseA ? courseA.priority : 999;
            const priorityB = courseB ? courseB.priority : 999;
            return priorityA - priorityB;
        });

        // 并发模式：同时尝试所有课程
        if (CONCURRENT_ENABLED) {
            for (let courseCode of sortedCourses) {
                attemptGrabSingleCourse(courseCode);
            }
        } else {
            // 顺序模式：按优先级依次尝试
            for (let courseCode of sortedCourses) {
                const state = getCourseState(courseCode);
                if (!state.selecting) {
                    attemptGrabSingleCourse(courseCode);
                    break; // 只尝试一个课程，等待结果
                }
            }
        }
    }

    // 开始抢课
    function startGrabbing(customCourses = null) {
        if (isRunning) {
            log('抢课脚本已在运行中！', 'warning');
            return;
        }

        // 使用自定义课程或默认课程
        const coursesToGrab = customCourses || TARGET_COURSES;

        if (!coursesToGrab || coursesToGrab.length === 0) {
            log('❌ 未配置目标课程！请先配置 TARGET_COURSES 或传入课程列表', 'error');
            alert('请先配置目标课程！\n\n在脚本中修改 TARGET_COURSES 数组，或使用：\ncourseGrabber.start([{code: "课程号", priority: 1}])');
            return;
        }

        // 请求通知权限
        if (window.Notification && Notification.permission === 'default') {
            Notification.requestPermission();
        }

        isRunning = true;
        attemptCount = 0;
        refreshInProgress = false;
        if (refreshTimeoutId) {
            clearTimeout(refreshTimeoutId);
            refreshTimeoutId = null;
        }

        // 初始化课程状态
        courseStates.clear();
        selectedCourses.clear();
        activeCourses.clear();

        for (let course of coursesToGrab) {
            const courseCode = typeof course === 'string' ? course : course.code;
            activeCourses.add(courseCode);
            initCourseState(courseCode);
        }

        // 该页面在展开课程卡片后才会生成教学班与选课控件。
        click2expend_enabled = CLICK2EXPEND_ENABLED;
        if (click2expend_enabled) {
            forceExpandTargetCoursesAggressive();
            log('📌 已启用目标课程详情展开，用于读取教学班与选课控件', 'info');
        }

        log(`🚀 开始监控 ${activeCourses.size} 门课程`, 'success');
        log(`📋 课程列表: ${Array.from(activeCourses).join(', ')}`, 'info');
        log(`⏱️ 检查间隔: ${CHECK_INTERVAL / 1000} 秒`, 'info');
        log('🎯 持续监控，直到选课成功或手动停止', 'info');
        log(`⚡ 并发模式: ${CONCURRENT_ENABLED ? '启用' : '禁用'}`, 'info');

        // 显示过滤器配置
        if (GLOBAL_TIME_FILTER.length > 0) {
            log(`🔍 全局时间过滤: ${GLOBAL_TIME_FILTER.join(', ')}`, 'info');
        }
        if (GLOBAL_TEACHER_FILTER.length > 0) {
            log(`🔍 全局教师过滤: ${GLOBAL_TEACHER_FILTER.join(', ')}`, 'info');
        }

        // 显示每门课程的特定过滤器
        for (let course of coursesToGrab) {
            if (typeof course === 'object') {
                if (course.timeFilter && course.timeFilter.length > 0) {
                    log(`🔍 [${course.code}] 时间过滤: ${course.timeFilter.join(', ')}`, 'info', course.code);
                }
                if (course.teacherFilter && course.teacherFilter.length > 0) {
                    log(`🔍 [${course.code}] 教师过滤: ${course.teacherFilter.join(', ')}`, 'info', course.code);
                }
            }
        }

        // 立即执行一次
        attemptGrabCourse();

        // 设置定时器
        intervalId = setInterval(() => {
            // 每8次尝试刷新一次课程列表
            // 注意：attemptCount 在 attemptGrabCourse() 内部自增；如果这里先走“刷新分支”，
            // attemptGrabCourse() 会被延迟 1s，这段时间内 attemptCount 不变，会导致下一次 interval 再次满足 %8===0，
            // 从而出现“已触发jQuery搜索刷新”连续打印两次的现象。
            if (attemptCount > 0 && attemptCount % 3 === 0 && !refreshInProgress) {
                refreshInProgress = true;
                refreshCourseList();
                refreshTimeoutId = setTimeout(() => {
                    refreshInProgress = false;
                    refreshTimeoutId = null;
                    attemptGrabCourse();
                }, 1000); // 刷新后等待1秒再尝试
            } else {
                attemptGrabCourse();
            }
        }, CHECK_INTERVAL);
    }

    // 停止抢课
    function stopGrabbing() {
        if (!isRunning) {
            const startButton = document.getElementById('cg-start-btn');
            const stopButton = document.getElementById('cg-stop-btn');
            if (startButton) startButton.disabled = false;
            if (stopButton) stopButton.disabled = true;
            log('抢课脚本未运行', 'info');
            return;
        }

        isRunning = false;
        refreshInProgress = false;
        if (intervalId) {
            clearInterval(intervalId);
            intervalId = null;
        }
        if (refreshTimeoutId) {
            clearTimeout(refreshTimeoutId);
            refreshTimeoutId = null;
        }

        const startButton = document.getElementById('cg-start-btn');
        const stopButton = document.getElementById('cg-stop-btn');
        if (startButton) startButton.disabled = false;
        if (stopButton) stopButton.disabled = true;

        log('⏹️ 抢课脚本已停止', 'warning');
    }

    // 获取状态
    function getStatus() {
        const status = {
            isRunning: isRunning,
            attemptCount: attemptCount,
            activeCourses: Array.from(activeCourses),
            selectedCourses: Array.from(selectedCourses),
            checkInterval: CHECK_INTERVAL,
            maxAttempts: MAX_ATTEMPTS,
            concurrentMode: CONCURRENT_ENABLED
        };

        console.log('%c========== 抢课状态 ==========', 'color: #00ffff; font-weight: bold; font-size: 16px;');
        console.table(status);

        // 显示每门课程的详细状态
        log('--- 课程详细状态 ---', 'info');
        for (let [courseCode, state] of courseStates) {
            log(`课程: ${courseCode}`, 'info');
            log(`  尝试次数: ${state.attempts}`, 'info');
            log(`  累计失败次数: ${state.failed}`, 'info');
            log(`  已尝试教学班: ${state.tried.size}个`, 'info');
            log(`  时间冲突教学班: ${state.conflicted.size}个`, 'info');
            log(`  正在选课: ${state.selecting ? '是' : '否'}`, 'info');
            log(`  选课成功: ${state.success ? '是' : '否'}`, state.success ? 'success' : 'info');
        }

        return {
            status,
            courseStates: Array.from(courseStates.entries()).map(([code, state]) => ({
                courseCode: code,
                attempts: state.attempts,
                failed: state.failed,
                triedCount: state.tried.size,
                conflictedCount: state.conflicted.size,
                selecting: state.selecting,
                success: state.success
            }))
        };
    }

    function showLogPanel() {
        const logSection = document.querySelector('.cg-log-section');
        if (logSection) {
            logSection.open = true;
        }
    }

    function clearActionResult() {
        const resultPanel = document.getElementById('cg-result-panel');
        if (resultPanel) {
            resultPanel.hidden = true;
            resultPanel.innerHTML = '';
        }
    }

    function appendResultLine(container, label, value, className = '') {
        const line = document.createElement('div');
        line.className = 'cg-result-line';

        const labelElement = document.createElement('span');
        labelElement.className = 'cg-result-label';
        labelElement.textContent = label;

        const valueElement = document.createElement('span');
        valueElement.className = `cg-result-value ${className}`.trim();
        valueElement.textContent = value;

        line.append(labelElement, valueElement);
        container.appendChild(line);
    }

    function renderActionResult(title, builder, resultClass = '') {
        const resultPanel = document.getElementById('cg-result-panel');
        if (!resultPanel) return;

        resultPanel.hidden = false;
        resultPanel.className = `cg-result-panel ${resultClass}`.trim();
        resultPanel.innerHTML = '';

        const titleElement = document.createElement('div');
        titleElement.className = 'cg-result-title';
        titleElement.textContent = title;
        resultPanel.appendChild(titleElement);
        builder(resultPanel);
    }

    function renderStatusResult(result) {
        const activeCodes = result.status.activeCourses.length > 0
            ? result.status.activeCourses
            : TARGET_COURSES.map(course => typeof course === 'string' ? course : course.code);

        renderActionResult('运行状态', panel => {
            appendResultLine(panel, '脚本', result.status.isRunning ? '运行中' : '未运行', result.status.isRunning ? 'cg-result-positive' : '');
            appendResultLine(panel, '当前轮次', String(result.status.attemptCount));
            appendResultLine(panel, '监控课程', activeCodes.length > 0 ? activeCodes.join('、') : '暂无');
            appendResultLine(panel, '已成功', result.status.selectedCourses.length > 0 ? result.status.selectedCourses.join('、') : '暂无');
            appendResultLine(panel, '检查间隔', `${result.status.checkInterval / 1000} 秒`);

            for (const course of result.courseStates) {
                const courseBlock = document.createElement('div');
                courseBlock.className = 'cg-result-course';
                courseBlock.textContent = course.courseCode;
                panel.appendChild(courseBlock);
                appendResultLine(panel, '尝试 / 失败', `${course.attempts} / ${course.failed}`);
                appendResultLine(panel, '教学班尝试', `${course.triedCount} 个`);
                appendResultLine(panel, '选课状态', course.success ? '成功' : course.selecting ? '提交中' : '等待中', course.success ? 'cg-result-positive' : '');
            }
        });
    }

    function renderDebugResult(debugInfo) {
        renderActionResult('页面调试结果', panel => {
            if (!debugInfo || debugInfo.length === 0) {
                appendResultLine(panel, '结果', '未找到教学班。请展开课程详情后重试。');
                return;
            }

            for (const item of debugInfo) {
                const courseBlock = document.createElement('div');
                courseBlock.className = 'cg-result-course';
                courseBlock.textContent = `${item.courseCode} · ${item.className}`;
                panel.appendChild(courseBlock);
                appendResultLine(panel, '教师', item.teacher);
                appendResultLine(panel, '人数', item.capacity);
                appendResultLine(panel, '时间', item.timeInfo);
                appendResultLine(panel, '页面允许选课', item.canSubmitSelection ? '是' : '否', item.canSubmitSelection ? 'cg-result-positive' : 'cg-result-negative');
                appendResultLine(panel, '筛选条件', item.filterMatch ? '通过' : `未通过：${item.filterReason || '不匹配'}`, item.filterMatch ? 'cg-result-positive' : 'cg-result-negative');
                appendResultLine(panel, '本次可尝试', item.canSelect ? '是' : '否', item.canSelect ? 'cg-result-positive' : 'cg-result-negative');
            }
        });
    }

    // 添加单门课程到监控列表
    function addCourse(courseCode, priority = 999) {
        if (activeCourses.has(courseCode)) {
            log(`课程 ${courseCode} 已在监控列表中`, 'warning');
            return false;
        }

        activeCourses.add(courseCode);
        initCourseState(courseCode);
        TARGET_COURSES.push({ code: courseCode, priority: priority });

        log(`✅ 已添加课程 ${courseCode} 到监控列表`, 'success');
        return true;
    }

    // 移除课程
    function removeCourse(courseCode) {
        if (!activeCourses.has(courseCode)) {
            log(`课程 ${courseCode} 不在监控列表中`, 'warning');
            return false;
        }

        activeCourses.delete(courseCode);
        courseStates.delete(courseCode);

        const index = TARGET_COURSES.findIndex(c => c.code === courseCode);
        if (index !== -1) {
            TARGET_COURSES.splice(index, 1);
        }

        log(`🗑️ 已从监控列表中移除课程 ${courseCode}`, 'warning');
        return true;
    }

    // 暴露全局控制接口
    window.grab = {
        // 开始抢课 - 可以传入自定义课程列表
        // 示例: grab.start([{code: 'CS101', priority: 1}, {code: 'CS102', priority: 2}])
        start: startGrabbing,

        // 停止抢课
        stop: stopGrabbing,

        // 查看状态
        status: getStatus,

        // 添加课程
        // 示例: grab.addCourse('CS103', 1)
        addCourse: addCourse,

        // 移除课程
        // 示例: grab.removeCourse('CS103')
        removeCourse: removeCourse,

        // 调试信息
        debug: (courseCode = null) => {
            log('=== 调试信息 ===', 'info');

            // 如果指定了课程，只调试该课程
            const configuredCourses = TARGET_COURSES.map(course => typeof course === 'string' ? course : course.code);
            const coursesToDebug = courseCode ? [courseCode] : (activeCourses.size > 0 ? Array.from(activeCourses) : configuredCourses);

            if (coursesToDebug.length === 0) {
                log('没有活跃的课程', 'warning');
                return null;
            }

            const debugInfo = [];

            for (let code of coursesToDebug) {
                log(`\n--- 课程: ${code} ---`, 'info');
                const classes = findAllTeachingClasses(code);
                log(`找到 ${classes.length} 个教学班`, 'info');

                const state = getCourseState(code);

                classes.forEach((tc, index) => {
                    const rowText = tc.row ? tc.row.textContent : '';

                    // 查找所有数字/数字格式
                    const allCapacityMatches = rowText.match(/\d+\/\d+/g) || [];

                    // 查找选课元素
                    let selectElement = null;
                    let selectElementInfo = '无选课元素';

                    if (tc.row) {
                        const allElements = tc.row.querySelectorAll('*');
                        for (let element of allElements) {
                            const elementText = element.textContent.trim();
                            if (elementText === '选课' || elementText.includes('选课')) {
                                if (!elementText.includes('退选')) {
                                    selectElement = element;
                                    selectElementInfo = `${element.tagName}(${elementText})`;
                                    break;
                                }
                            }
                        }

                        // 如果没找到选课元素，列出所有可点击元素
                        if (!selectElement) {
                            const clickableElements = tc.row.querySelectorAll('button, a, input[type="button"], [onclick]');
                            const clickableInfo = Array.from(clickableElements).map(el =>
                                `${el.tagName}(${el.textContent.trim()})`
                            ).join(', ');
                            selectElementInfo = `可点击元素: ${clickableInfo || '无'}`;
                        }
                    }

                    // 检查选课/退选状态
                    const isSelectAvailable = rowText.includes('选课');
                    const isDropAvailable = rowText.includes('退选');

                    log(`教学班 ${index + 1}:`, 'info', code);
                    log(`  名称: ${tc.info.className}`, 'info', code);
                    log(`  教师: ${tc.info.teacher}`, 'info', code);
                    log(`  容量: ${tc.info.capacity}`, 'info', code);
                    log(`  所有容量信息: [${allCapacityMatches.join(', ')}]`, 'info', code);
                    log(`  时间: ${tc.info.timeInfo}`, 'info', code);
                    log(`  选课元素: ${selectElementInfo}`, 'info', code);
                    log(`  行包含选课: ${isSelectAvailable}`, 'info', code);
                    log(`  行包含退选: ${isDropAvailable}`, 'info', code);
                    log(`  ID: ${tc.info.id}`, 'info', code);
                    log(`  页面允许选课: ${isTeachingClassSelectable(tc)}`, 'info', code);
                    log(`  已尝试: ${state.tried.has(tc.info.id)}`, 'info', code);
                    log(`  时间冲突: ${state.conflicted.has(tc.info.id)}`, 'info', code);

                    // 检查过滤器匹配
                    const filterResult = matchesFilters(tc, code);
                    log(`  过滤器: ${filterResult.match ? '✅通过' : '❌' + filterResult.reason}`, 'info', code);
                    log(`  可选择: ${isSelectAvailable && !isDropAvailable && isTeachingClassSelectable(tc) && !state.conflicted.has(tc.info.id) && filterResult.match}`, 'info', code);

                    debugInfo.push({
                        courseCode: code,
                        index: index + 1,
                        className: tc.info.className,
                        teacher: tc.info.teacher,
                        capacity: tc.info.capacity,
                        timeInfo: tc.info.timeInfo,
                        canSubmitSelection: isTeachingClassSelectable(tc),
                        tried: state.tried.has(tc.info.id),
                        conflicted: state.conflicted.has(tc.info.id),
                        filterMatch: filterResult.match,
                        filterReason: filterResult.reason,
                        canSelect: isSelectAvailable && !isDropAvailable && isTeachingClassSelectable(tc) && !state.conflicted.has(tc.info.id) && filterResult.match
                    });
                });
            }

            return debugInfo;
        },

        // 定时开抢
        schedule: (timeString) => {
            const targetTime = new Date(timeString);
            if (isNaN(targetTime.getTime())) {
                log('❌ 时间格式错误！请使用如: "2025-12-19 14:00:00"', 'error');
                return false;
            }
            setScheduledStart(targetTime);
            return true;
        },

        cancelSchedule: () => {
            cancelScheduledStart();
        },

        // 配置管理
        config: {
            getCourses: () => TARGET_COURSES,
            setCourses: (courses) => {
                TARGET_COURSES.length = 0;
                TARGET_COURSES.push(...courses);
                log('✅ 已更新课程配置', 'success');
            },
            getInterval: () => CHECK_INTERVAL,
            getConcurrentMode: () => CONCURRENT_ENABLED,
            getGlobalTimeFilter: () => GLOBAL_TIME_FILTER,
            getGlobalTeacherFilter: () => GLOBAL_TEACHER_FILTER,
            // 显示过滤器信息
            showFilters: () => {
                console.log('%c=== 过滤器配置 ===', 'color: #00ffff; font-weight: bold; font-size: 16px;');
                console.log('%c全局时间过滤:', 'color: #ffaa00; font-weight: bold;');
                if (GLOBAL_TIME_FILTER.length > 0) {
                    console.log('  ' + GLOBAL_TIME_FILTER.join(', '));
                } else {
                    console.log('  未配置（不过滤）');
                }
                console.log('%c全局教师过滤:', 'color: #ffaa00; font-weight: bold;');
                if (GLOBAL_TEACHER_FILTER.length > 0) {
                    console.log('  ' + GLOBAL_TEACHER_FILTER.join(', '));
                } else {
                    console.log('  未配置（不过滤）');
                }
                console.log('%c课程特定过滤:', 'color: #ffaa00; font-weight: bold;');
                TARGET_COURSES.forEach(course => {
                    console.log(`  ${course.code}:`);
                    if (course.timeFilter) {
                        console.log(`    时间: ${course.timeFilter.join(', ')}`);
                    }
                    if (course.teacherFilter) {
                        console.log(`    教师: ${course.teacherFilter.join(', ')}`);
                    }
                    if (!course.timeFilter && !course.teacherFilter) {
                        console.log(`    无特定过滤`);
                    }
                });
            }
        }
    };

    // 显示脚本信息
    console.log('%c🎓 自动抢课脚本已加载 - 多课程并发版', 'color: #ff6b35; font-size: 18px; font-weight: bold;');
    console.log('%c✨ 新特性: 支持多门课程同时抢课！', 'color: #00ff00; font-size: 16px; font-weight: bold;');
    console.log('%c📚 目标课程数: ' + TARGET_COURSES.length, 'color: #4ecdc4; font-size: 14px; font-weight: bold;');
    console.log('%c⚡ 使用方法:', 'color: #45b7d1; font-size: 14px; font-weight: bold;');
    console.log('  grab.start()  - 🚀 开始抢课（使用配置的课程）');
    console.log('  grab.start([{code:"CS101", priority:1}])  - 🚀 使用自定义课程列表');
    console.log('  grab.stop()   - ⏹️ 停止抢课');
    console.log('  grab.status() - 📊 查看状态');
    console.log('  grab.debug()  - 🔍 调试所有课程');
    console.log('  grab.debug("CS101")  - 🔍 调试指定课程');
    console.log('  grab.addCourse("CS101", 1)  - ➕ 添加课程到监控列表');
    console.log('  grab.removeCourse("CS101")  - ➖ 移除课程');
    console.log('%c⚠️ 提醒: 确保您在正确的选课页面且已登录！', 'color: #ffa500; font-weight: bold;');
    console.log('%c🛡️ 智能保护:', 'color: #ff69b4; font-weight: bold;');
    console.log('  • 多课程并发抢课（可配置）');
    console.log('  • 优先级控制（数字越小优先级越高）');
    console.log('  • 自动识别同一课程的多个教学班');
    console.log('  • 时间冲突时自动尝试其他教学班');
    console.log('  • 独立跟踪每门课程的状态');
    console.log('  • 自动处理选课成功和失败');
    console.log('%c📋 配置示例:', 'color: #9370db; font-weight: bold;');
    console.log('  在脚本顶部修改 TARGET_COURSES:');
    console.log('  const TARGET_COURSES = [');
    console.log('    { code: "23286514", priority: 1 },  // 使用课程号');
    console.log('    { code: "机器学习", priority: 1 },  // 使用课程名称');
    console.log('    { code: "CS102", priority: 2, timeFilter: ["星期一", "第1-2节"] },  // 只选星期一或1-2节的课');
    console.log('    { code: "CS103", priority: 3, teacherFilter: ["张三", "讲师"] }  // 只选张三或讲师的课');
    console.log('  ];');
    console.log('%c🆕 新功能: 支持课程号和课程名称两种输入方式！', 'color: #00ff00; font-weight: bold;');
    console.log('%c🔍 过滤器功能:', 'color: #ff1493; font-weight: bold;');
    console.log('  • timeFilter - 时间过滤（支持星期、节次等关键词）');
    console.log('  • teacherFilter - 教师过滤（支持教师姓名、职称等关键词）');
    console.log('  • grab.config.showFilters() - 查看当前过滤器配置');
    console.log('%c💡 提示: 并发模式已' + (CONCURRENT_ENABLED ? '启用' : '禁用'), 'color: #00ffff; font-weight: bold;');

    // 如果配置了过滤器，显示提示
    if (GLOBAL_TIME_FILTER.length > 0 || GLOBAL_TEACHER_FILTER.length > 0) {
        console.log('%c⚠️ 已启用全局过滤器:', 'color: #ffa500; font-weight: bold;');
        if (GLOBAL_TIME_FILTER.length > 0) {
            console.log('  时间: ' + GLOBAL_TIME_FILTER.join(', '));
        }
        if (GLOBAL_TEACHER_FILTER.length > 0) {
            console.log('  教师: ' + GLOBAL_TEACHER_FILTER.join(', '));
        }
    }

    // ========== UI界面 ==========
    // 创建UI控制面板
    function createUI() {
        // 扩展重载后重新创建并绑定面板，避免沿用旧脚本的事件处理器。
        const existingUI = document.getElementById('courseGrabberUI');
        if (existingUI) {
            existingUI.remove();
        }
        const existingStyle = document.getElementById('courseGrabberUI-style');
        if (existingStyle) {
            existingStyle.remove();
        }

        // 创建样式
        const style = document.createElement('style');
        style.id = 'courseGrabberUI-style';
        style.textContent = `
            #courseGrabberUI {
                position: fixed;
                top: 16px;
                right: 16px;
                width: min(360px, calc(100vw - 32px));
                max-height: calc(100vh - 32px);
                background: #ffffff;
                border: 1px solid #d9e0e8;
                border-radius: 8px;
                box-shadow: 0 10px 28px rgba(31, 41, 55, 0.16);
                z-index: 999999;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                color: #1f2937;
                overflow: hidden;
                display: flex;
                flex-direction: column;
            }
            #courseGrabberUI * {
                box-sizing: border-box;
            }
            .cg-header {
                min-height: 48px;
                padding: 10px 12px 10px 16px;
                background: #f8fafc;
                border-bottom: 1px solid #e5e7eb;
                cursor: move;
                display: flex;
                justify-content: space-between;
                align-items: center;
                user-select: none;
            }
            .cg-title {
                font-size: 14px;
                font-weight: 650;
                display: flex;
                align-items: center;
                gap: 6px;
                letter-spacing: 0;
            }
            .cg-close,
            .cg-minimize {
                appearance: none;
                width: 28px;
                height: 28px;
                padding: 0;
                border: 1px solid transparent;
                border-radius: 6px;
                background: transparent;
                color: #5b6574;
                cursor: pointer;
                font-size: 17px;
                line-height: 1;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background-color 0.15s, color 0.15s;
            }
            .cg-close:hover,
            .cg-minimize:hover {
                background: #e9eef5;
                color: #1f2937;
            }
            .cg-body {
                padding: 0 16px 14px;
                overflow-y: auto;
                flex: 1;
            }
            .cg-section {
                margin: 0;
                padding: 14px 0;
                border-top: 1px solid #e5e7eb;
            }
            .cg-section:first-child {
                border-top: 0;
            }
            .cg-section-title {
                font-size: 12px;
                font-weight: 650;
                margin-bottom: 8px;
                color: #4b5563;
                display: flex;
                align-items: center;
                gap: 4px;
                letter-spacing: 0;
            }
            .cg-input {
                width: 100%;
                min-height: 34px;
                padding: 7px 9px;
                border: 1px solid #cfd7e3;
                background: #ffffff;
                border-radius: 6px;
                color: #1f2937;
                font-size: 12px;
                margin: 0;
                transition: border-color 0.15s, box-shadow 0.15s;
            }
            .cg-input:focus {
                outline: none;
                border-color: #2f80d1;
                box-shadow: 0 0 0 2px rgba(47, 128, 209, 0.14);
            }
            .cg-input::placeholder {
                color: #8a94a3;
            }
            .cg-btn {
                min-height: 34px;
                padding: 7px 10px;
                border: 1px solid transparent;
                border-radius: 6px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 600;
                transition: background-color 0.15s, border-color 0.15s, color 0.15s;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                white-space: nowrap;
            }
            .cg-btn-primary {
                background: #1769aa;
                color: #ffffff;
            }
            .cg-btn-primary:hover {
                background: #13598f;
            }
            .cg-btn-danger {
                background: #fff4f4;
                border-color: #ebc8c8;
                color: #b42318;
            }
            .cg-btn-danger:hover {
                background: #ffe8e8;
                border-color: #d99e9e;
            }
            .cg-btn-secondary {
                background: #ffffff;
                border-color: #cfd7e3;
                color: #374151;
            }
            .cg-btn-secondary:hover {
                background: #f5f7fa;
                border-color: #b6c1d0;
            }
            .cg-btn-small {
                min-height: 30px;
                padding: 5px 8px;
                font-size: 12px;
            }
            .cg-btn:disabled {
                cursor: default;
                opacity: 0.48;
            }
            .cg-course-entry {
                display: grid;
                grid-template-columns: minmax(0, 1fr) 70px;
                gap: 8px;
            }
            .cg-advanced {
                margin-top: 10px;
            }
            .cg-advanced summary,
            .cg-log-section summary {
                color: #667085;
                cursor: pointer;
                font-size: 12px;
                list-style: none;
            }
            .cg-advanced summary::-webkit-details-marker,
            .cg-log-section summary::-webkit-details-marker {
                display: none;
            }
            .cg-advanced summary::before,
            .cg-log-section summary::before {
                content: '+';
                display: inline-block;
                width: 14px;
                color: #667085;
            }
            .cg-advanced[open] summary::before,
            .cg-log-section[open] summary::before {
                content: '-';
            }
            .cg-advanced-fields {
                display: grid;
                gap: 7px;
                padding-top: 9px;
            }
            .cg-btn-group {
                display: flex;
                gap: 8px;
                margin-top: 8px;
            }
            .cg-course-list {
                max-height: 132px;
                overflow-y: auto;
                margin: 0;
            }
            .cg-course-item {
                padding: 9px 0;
                border-bottom: 1px solid #edf0f4;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .cg-course-item:last-child {
                border-bottom: 0;
            }
            .cg-course-info {
                flex: 1;
                font-size: 13px;
                min-width: 0;
            }
            .cg-course-code {
                font-weight: 650;
                margin-bottom: 3px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .cg-course-meta {
                font-size: 11px;
                color: #7a8594;
            }
            .cg-status {
                min-height: 22px;
                font-size: 12px;
                display: flex;
                align-items: center;
                gap: 6px;
                color: #667085;
            }
            .cg-status-dot {
                width: 7px;
                height: 7px;
                border-radius: 50%;
                background: #16a34a;
                animation: pulse 2s infinite;
            }
            @keyframes pulse {
                0%, 100% { opacity: 1; }
                50% { opacity: 0.5; }
            }
            .cg-log-area {
                margin-top: 9px;
                padding: 8px;
                max-height: 120px;
                overflow-y: auto;
                font-size: 11px;
                font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
                line-height: 1.5;
                background: #f7f9fb;
                border: 1px solid #e5e7eb;
                border-radius: 6px;
            }
            .cg-result-panel {
                margin-top: 9px;
                padding: 9px;
                max-height: 220px;
                overflow-y: auto;
                background: #f7f9fb;
                border: 1px solid #d9e0e8;
                border-radius: 6px;
                font-size: 11px;
                line-height: 1.5;
            }
            .cg-result-title {
                margin-bottom: 6px;
                color: #1f2937;
                font-size: 12px;
                font-weight: 650;
            }
            .cg-result-line {
                display: grid;
                grid-template-columns: 76px minmax(0, 1fr);
                gap: 7px;
                padding: 2px 0;
            }
            .cg-result-label {
                color: #7a8594;
            }
            .cg-result-value {
                min-width: 0;
                overflow-wrap: anywhere;
                color: #374151;
            }
            .cg-result-positive {
                color: #15803d;
                font-weight: 650;
            }
            .cg-result-negative {
                color: #b42318;
                font-weight: 650;
            }
            .cg-result-course {
                margin-top: 7px;
                padding-top: 7px;
                border-top: 1px solid #e5e7eb;
                color: #2767a4;
                font-weight: 650;
                overflow-wrap: anywhere;
            }
            .cg-log-item {
                margin-bottom: 3px;
            }
            .cg-log-success { color: #15803d; }
            .cg-log-error { color: #b42318; }
            .cg-log-warning { color: #a15c00; }
            .cg-log-info { color: #2767a4; }
            .cg-badge {
                display: inline-block;
                padding: 1px 5px;
                background: #edf2f7;
                border-radius: 4px;
                font-size: 11px;
                color: #526070;
                margin-left: 6px;
                font-weight: 500;
            }
            .cg-badge-success {
                color: #15803d;
            }
            .cg-badge-running {
                color: #15803d;
                font-weight: 650;
            }
            .cg-controls {
                display: flex;
                gap: 2px;
            }
            .cg-minimized {
                height: auto !important;
                width: 132px !important;
            }
            .cg-minimized .cg-body {
                display: none !important;
            }
            .cg-filter-input {
                font-size: 12px;
            }
            .cg-help-text {
                display: none;
            }
            .cg-timer-display {
                background: #edf7ee;
                padding: 8px;
                border-radius: 6px;
                text-align: center;
                font-size: 16px;
                font-weight: 650;
                letter-spacing: 0;
                margin-top: 8px;
                font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
            }
            .cg-timer-active {
                color: #1769aa;
            }
            .cg-time-input-group {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            .cg-time-input-group input {
                flex: 1;
            }
            .cg-course-filters {
                margin-top: 4px;
                font-size: 11px;
                color: #667085;
            }
            .cg-course-filter-item {
                margin-bottom: 2px;
                display: flex;
                align-items: center;
                gap: 4px;
            }
            .cg-course-filter-item:last-child {
                margin-bottom: 0;
            }
            .cg-filter-label {
                min-width: 32px;
                color: #7a8594;
            }
            .cg-course-actions {
                display: flex;
                gap: 4px;
                flex-direction: row;
                margin-left: 8px;
            }
            .cg-course-actions .cg-btn {
                width: 30px;
                padding: 0;
            }
            @media (max-width: 480px) {
                #courseGrabberUI {
                    top: 8px;
                    right: 8px;
                    width: calc(100vw - 16px);
                    max-height: calc(100vh - 16px);
                }
            }
        `;
        document.head.appendChild(style);

        // 创建UI容器
        const ui = document.createElement('div');
        ui.id = 'courseGrabberUI';
        ui.innerHTML = `
            <div class="cg-header">
                <div class="cg-title">
                    <span>选课助手</span>
                </div>
                <div class="cg-controls">
                    <button class="cg-minimize" id="cg-minimize-btn" title="最小化">−</button>
                    <button class="cg-close" id="cg-close-btn" title="关闭">×</button>
                </div>
            </div>
            <div class="cg-body">
                <div class="cg-section cg-status-section">
                    <div id="cg-status-display">
                        <div class="cg-status">
                            <span>状态</span>
                            <span id="cg-status-text">未运行</span>
                        </div>
                    </div>
                </div>

                <div class="cg-section">
                    <div class="cg-section-title">目标课程</div>
                    <div class="cg-course-entry">
                        <input type="text" class="cg-input" id="cg-course-code" placeholder="课程号或课程名称">
                        <input type="number" class="cg-input" id="cg-course-priority" aria-label="优先级" title="优先级，数字越小越优先" value="1" min="1">
                    </div>
                    <details class="cg-advanced">
                        <summary>筛选与换课</summary>
                        <div class="cg-advanced-fields">
                            <input type="text" class="cg-input cg-filter-input" id="cg-time-filter" placeholder="时间筛选，例如：星期一,第1-2节">
                            <input type="text" class="cg-input cg-filter-input" id="cg-teacher-filter" placeholder="教师筛选，例如：张三,讲师">
                            <input type="text" class="cg-input cg-filter-input" id="cg-replace-code" placeholder="替换课程号">
                        </div>
                    </details>
                    <button class="cg-btn cg-btn-secondary" id="cg-add-course" style="width: 100%; margin-top: 10px;">添加课程</button>
                </div>

                <div class="cg-section">
                    <div class="cg-section-title">监控列表</div>
                    <div class="cg-course-list" id="cg-course-list"></div>
                </div>

                <div class="cg-section">
                    <div class="cg-section-title">定时启动</div>
                    <div class="cg-time-input-group">
                        <input type="datetime-local" class="cg-input" id="cg-schedule-time" placeholder="选择开抢时间">
                        <button class="cg-btn cg-btn-secondary cg-btn-small" id="cg-schedule-btn">确定</button>
                    </div>
                    <div id="cg-timer-display" style="display: none;"></div>
                </div>

                <div class="cg-section">
                    <div class="cg-btn-group" style="margin-top: 0;">
                        <button class="cg-btn cg-btn-primary" id="cg-start-btn" style="flex: 1;">开始抢课</button>
                        <button class="cg-btn cg-btn-danger" id="cg-stop-btn" style="flex: 1;" disabled>停止</button>
                    </div>
                    <div class="cg-btn-group">
                        <button class="cg-btn cg-btn-secondary cg-btn-small" id="cg-status-btn" style="flex: 1;">查看状态</button>
                        <button class="cg-btn cg-btn-secondary cg-btn-small" id="cg-debug-btn" style="flex: 1;">调试</button>
                    </div>
                    <div id="cg-result-panel" class="cg-result-panel" hidden></div>
                </div>

                <details class="cg-section cg-log-section">
                    <summary>运行日志</summary>
                    <div class="cg-log-area" id="cg-log-area"></div>
                </details>
            </div>
        `;

        document.body.appendChild(ui);

        // 添加拖拽功能
        makeDraggable(ui);

        // 绑定事件
        bindUIEvents();

        // 初始化课程列表
        updateCourseList();

        console.log('%c✨ UI界面已加载！可拖动面板到任意位置', 'color: #43e97b; font-weight: bold; font-size: 14px;');
    }

    // 使UI可拖拽
    function makeDraggable(element) {
        const header = element.querySelector('.cg-header');
        let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

        header.onmousedown = dragMouseDown;

        function dragMouseDown(e) {
            e.preventDefault();
            pos3 = e.clientX;
            pos4 = e.clientY;
            document.onmouseup = closeDragElement;
            document.onmousemove = elementDrag;
        }

        function elementDrag(e) {
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            element.style.top = (element.offsetTop - pos2) + "px";
            element.style.left = (element.offsetLeft - pos1) + "px";
            element.style.right = "auto";
        }

        function closeDragElement() {
            document.onmouseup = null;
            document.onmousemove = null;
        }
    }

    // 绑定UI事件
    function bindUIEvents() {
        // 关闭按钮
        document.getElementById('cg-close-btn').onclick = () => {
            document.getElementById('courseGrabberUI').style.display = 'none';
        };

        // 最小化按钮
        document.getElementById('cg-minimize-btn').onclick = () => {
            const ui = document.getElementById('courseGrabberUI');
            ui.classList.toggle('cg-minimized');
            const btn = document.getElementById('cg-minimize-btn');
            btn.textContent = ui.classList.contains('cg-minimized') ? '□' : '−';
        };

        // 添加课程
        document.getElementById('cg-add-course').onclick = () => {
            const code = document.getElementById('cg-course-code').value.trim();
            const priority = parseInt(document.getElementById('cg-course-priority').value) || 1;

            if (!code) {
                alert('请输入课程号！');
                return;
            }

            // 检查是否已存在
            let courseAlreadyAdded = false;
            for (let i = 0; i < TARGET_COURSES.length; i++) {
                if (TARGET_COURSES[i].code === code) {
                    courseAlreadyAdded = true;
                    break;
                }
            }
            if (courseAlreadyAdded) {
                alert('该课程已存在！');
                return;
            }

            // 获取替换课程和过滤器（使用querySelector作为备用方案）
            const replaceCodeEl = document.getElementById('cg-replace-code');
            const timeFilterEl = document.getElementById('cg-time-filter');
            const teacherFilterEl = document.getElementById('cg-teacher-filter');

            const replaceCode = (replaceCodeEl ? replaceCodeEl.value : '').trim();
            const timeFilterInput = (timeFilterEl ? timeFilterEl.value : '').trim();
            const teacherFilterInput = (teacherFilterEl ? teacherFilterEl.value : '').trim();

            // 构造最终要推入的课程对象，避免作用域或外部修改影响
            const finalCourse = { code: code, priority: priority };
            if (replaceCode) finalCourse.replaceCode = replaceCode;

            // 使用安全的解析函数处理过滤器输入（避免被篡改的 Array.prototype.filter）
            const finalTimeFilter = safeParseFilterInput(timeFilterInput);
            if (finalTimeFilter.length > 0) {
                finalCourse.timeFilter = finalTimeFilter;
            }

            const finalTeacherFilter = safeParseFilterInput(teacherFilterInput);
            if (finalTeacherFilter.length > 0) {
                finalCourse.teacherFilter = finalTeacherFilter;
            }

            // 直接推入 finalCourse（是新对象）
            TARGET_COURSES.push(finalCourse);

            // 清空所有输入
            document.getElementById('cg-course-code').value = '';
            document.getElementById('cg-course-priority').value = '1';
            document.getElementById('cg-replace-code').value = '';
            document.getElementById('cg-time-filter').value = '';
            document.getElementById('cg-teacher-filter').value = '';

            updateCourseList();

            let logMsg = `已添加课程: ${code} (优先级: ${priority})`;
            if (finalCourse.replaceCode) logMsg += ` [替换: ${finalCourse.replaceCode}]`;
            if (finalCourse.timeFilter && finalCourse.timeFilter.length > 0) {
                logMsg += ` [时间过滤: ${finalCourse.timeFilter.join(', ')}]`;
            }
            if (finalCourse.teacherFilter && finalCourse.teacherFilter.length > 0) {
                logMsg += ` [教师过滤: ${finalCourse.teacherFilter.join(', ')}]`;
            }
            addUILog('success', logMsg);
        };

        // 开始抢课
        document.getElementById('cg-start-btn').onclick = () => {
            if (TARGET_COURSES.length === 0) {
                alert('请先添加至少一门课程！');
                return;
            }

            clearActionResult();
            window.grab.start();
            document.getElementById('cg-start-btn').disabled = isRunning;
            document.getElementById('cg-stop-btn').disabled = !isRunning;
            updateStatusDisplay();
        };

        // 停止抢课
        document.getElementById('cg-stop-btn').onclick = () => {
            window.grab.stop();
            document.getElementById('cg-start-btn').disabled = false;
            document.getElementById('cg-stop-btn').disabled = true;
            updateStatusDisplay();
        };

        // 查看状态
        document.getElementById('cg-status-btn').onclick = () => {
            const status = window.grab.status();
            renderStatusResult(status);
            showLogPanel();
        };

        // 调试
        document.getElementById('cg-debug-btn').onclick = () => {
            const debugInfo = window.grab.debug();
            renderDebugResult(debugInfo);
            showLogPanel();
        };

        // 定时开抢
        document.getElementById('cg-schedule-btn').onclick = () => {
            const timeInput = document.getElementById('cg-schedule-time');
            const timeValue = timeInput.value;

            if (!timeValue) {
                alert('请先选择开抢时间！');
                return;
            }

            const scheduleTime = new Date(timeValue);
            const now = new Date();

            if (scheduleTime <= now) {
                alert('开抢时间必须大于当前时间！');
                return;
            }

            if (TARGET_COURSES.length === 0) {
                alert('请先添加至少一门课程！');
                return;
            }

            setScheduledStart(scheduleTime);
        };

        // 定期更新状态
        setInterval(updateStatusDisplay, 1000);
    }

    // 更新课程列表显示
    function updateCourseList() {
        const list = document.getElementById('cg-course-list');
        if (TARGET_COURSES.length === 0) {
            list.innerHTML = '<div class="cg-course-meta" style="padding: 8px 0;">暂无课程</div>';
            return;
        }

        list.innerHTML = TARGET_COURSES.map((course, index) => {
            const hasConfig = course.replaceCode || course.timeFilter || course.teacherFilter;

            let filterHTML = '';
            if (hasConfig) {
                filterHTML = '<div class="cg-course-filters">';
                if (course.replaceCode) {
                    filterHTML += `<div class="cg-course-filter-item"><span class="cg-filter-label">替换</span><span>${course.replaceCode}</span></div>`;
                }
                if (course.timeFilter) {
                    filterHTML += `<div class="cg-course-filter-item"><span class="cg-filter-label">时间</span><span>${course.timeFilter.join(', ')}</span></div>`;
                }
                if (course.teacherFilter) {
                    filterHTML += `<div class="cg-course-filter-item"><span class="cg-filter-label">教师</span><span>${course.teacherFilter.join(', ')}</span></div>`;
                }
                filterHTML += '</div>';
            } else {
                filterHTML = '<div class="cg-course-meta">未设置筛选</div>';
            }

            return `
                <div class="cg-course-item">
                    <div class="cg-course-info">
                        <div class="cg-course-code">${course.code} <span class="cg-badge">P${course.priority}</span></div>
                        ${filterHTML}
                    </div>
                    <div class="cg-course-actions">
                        <button class="cg-btn cg-btn-secondary cg-btn-small" onclick="window.editCourseUI(${index})" aria-label="编辑课程" title="编辑课程">✏</button>
                        <button class="cg-btn cg-btn-danger cg-btn-small" onclick="window.removeCourseUI(${index})" aria-label="删除课程" title="删除课程">×</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    // 删除课程（UI调用）
    window.removeCourseUI = (index) => {
        const course = TARGET_COURSES[index];
        if (confirm(`确定要删除课程 ${course.code} 吗？`)) {
            TARGET_COURSES.splice(index, 1);
            updateCourseList();
            addUILog('warning', `已删除课程: ${course.code}`);
        }
    };

    // 编辑课程过滤器（UI调用）
    window.editCourseUI = (index) => {
        const course = TARGET_COURSES[index];

        const replaceCode = prompt(
            `编辑课程 ${course.code} 的替换课程\n\n输入要替换的课程号，留空表示不替换\n例如: 23306047`,
            course.replaceCode || ''
        );

        if (replaceCode === null) return; // 用户取消

        const timeFilter = prompt(
            `编辑课程 ${course.code} 的时间过滤器\n\n多个关键词用逗号分隔，留空表示不过滤\n例如: 星期一,第1-2节`,
            course.timeFilter ? course.timeFilter.join(',') : ''
        );

        if (timeFilter === null) return; // 用户取消

        const teacherFilter = prompt(
            `编辑课程 ${course.code} 的教师过滤器\n\n多个关键词用逗号分隔，留空表示不过滤\n例如: 张三,讲师`,
            course.teacherFilter ? course.teacherFilter.join(',') : ''
        );

        if (teacherFilter === null) return; // 用户取消

        // 更新课程配置
        if (replaceCode.trim()) {
            course.replaceCode = replaceCode.trim();
        } else {
            delete course.replaceCode;
        }

        // 使用安全的解析函数处理过滤器输入（避免被篡改的 Array.prototype.filter）
        const parsedTimeFilter = safeParseFilterInput(timeFilter);
        if (parsedTimeFilter.length > 0) {
            course.timeFilter = parsedTimeFilter;
        } else {
            delete course.timeFilter;
        }

        const parsedTeacherFilter = safeParseFilterInput(teacherFilter);
        if (parsedTeacherFilter.length > 0) {
            course.teacherFilter = parsedTeacherFilter;
        } else {
            delete course.teacherFilter;
        }

        updateCourseList();
        addUILog('info', `已更新课程 ${course.code} 的过滤器`);
    };

    // 更新状态显示
    function updateStatusDisplay() {
        const statusText = document.getElementById('cg-status-text');

        if (statusText) {
            if (isRunning) {
                statusText.innerHTML = '<span class="cg-status-dot"></span>运行中';
                statusText.className = 'cg-badge-running';
            } else {
                statusText.textContent = '未运行';
                statusText.className = '';
            }
        }
    }

    // 添加UI日志
    function addUILog(type, message) {
        const logArea = document.getElementById('cg-log-area');
        if (!logArea) return;

        const time = new Date().toLocaleTimeString();
        const logItem = document.createElement('div');
        logItem.className = `cg-log-item cg-log-${type}`;
        logItem.textContent = `[${time}] ${message}`;

        logArea.appendChild(logItem);
        logArea.scrollTop = logArea.scrollHeight;

        // 限制日志数量
        while (logArea.children.length > 100) {
            logArea.removeChild(logArea.firstChild);
        }
    }

    // 设置定时开抢
    function setScheduledStart(targetTime) {
        // 取消之前的定时器
        if (schedulerIntervalId) {
            clearInterval(schedulerIntervalId);
        }

        scheduledTime = targetTime;
        isScheduled = true;

        // 显示倒计时
        const timerDisplay = document.getElementById('cg-timer-display');
        timerDisplay.style.display = 'block';
        timerDisplay.className = 'cg-timer-display cg-timer-active';

        // 禁用立即开始按钮
        document.getElementById('cg-start-btn').disabled = true;
        document.getElementById('cg-schedule-btn').textContent = '❌ 取消';
        document.getElementById('cg-schedule-btn').onclick = cancelScheduledStart;

        addUILog('info', `已设置定时开抢: ${targetTime.toLocaleString()}`);
        log(`⏰ 定时开抢已设置，将在 ${targetTime.toLocaleString()} 自动开始`, 'success');

        // 启动倒计时
        schedulerIntervalId = setInterval(() => {
            const now = new Date();
            const diff = scheduledTime - now;

            if (diff <= 0) {
                // 时间到，开始抢课
                clearInterval(schedulerIntervalId);
                isScheduled = false;
                timerDisplay.style.display = 'none';

                addUILog('success', '⏰ 定时时间已到，开始抢课！');
                log('⏰ 定时时间已到，自动开始抢课！', 'success');

                // 重置按钮
                document.getElementById('cg-schedule-btn').textContent = '⏰ 设置';
                document.getElementById('cg-schedule-btn').onclick = document.getElementById('cg-schedule-btn').onclick;

                // 开始抢课
                window.grab.start();
                document.getElementById('cg-start-btn').disabled = isRunning;
                document.getElementById('cg-stop-btn').disabled = !isRunning;
            } else {
                // 更新倒计时显示
                updateCountdown(diff);
            }
        }, 100);
    }

    // 取消定时开抢
    function cancelScheduledStart() {
        if (schedulerIntervalId) {
            clearInterval(schedulerIntervalId);
        }

        scheduledTime = null;
        isScheduled = false;

        const timerDisplay = document.getElementById('cg-timer-display');
        timerDisplay.style.display = 'none';

        document.getElementById('cg-start-btn').disabled = false;
        document.getElementById('cg-schedule-btn').textContent = '⏰ 设置';

        // 重新绑定设置事件
        const scheduleBtn = document.getElementById('cg-schedule-btn');
        scheduleBtn.onclick = () => {
            const timeInput = document.getElementById('cg-schedule-time');
            const timeValue = timeInput.value;

            if (!timeValue) {
                alert('请先选择开抢时间！');
                return;
            }

            const scheduleTime = new Date(timeValue);
            const now = new Date();

            if (scheduleTime <= now) {
                alert('开抢时间必须大于当前时间！');
                return;
            }

            if (TARGET_COURSES.length === 0) {
                alert('请先添加至少一门课程！');
                return;
            }

            setScheduledStart(scheduleTime);
        };

        addUILog('warning', '已取消定时开抢');
        log('⏰ 定时开抢已取消', 'warning');
    }

    // 更新倒计时显示
    function updateCountdown(milliseconds) {
        const timerDisplay = document.getElementById('cg-timer-display');
        if (!timerDisplay) return;

        const totalSeconds = Math.floor(milliseconds / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;
        const ms = Math.floor((milliseconds % 1000) / 10);

        let timeString = '';
        if (hours > 0) {
            timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        } else {
            timeString = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(2, '0')}`;
        }

        timerDisplay.textContent = `⏰ ${timeString}`;

        // 最后10秒加速闪烁
        if (totalSeconds <= 10 && totalSeconds > 0) {
            timerDisplay.style.animation = 'timerPulse 0.5s infinite';
        }
    }

    // 自动创建UI
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', createUI);
    } else {
        createUI();
    }

    // 提供手动显示UI的方法
    window.showGrabberUI = () => {
        const ui = document.getElementById('courseGrabberUI');
        if (ui) {
            ui.style.display = 'flex';
        } else {
            createUI();
        }
    };

})();
