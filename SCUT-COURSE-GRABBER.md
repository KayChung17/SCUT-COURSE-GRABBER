# 华工自主选课脚本

`scutCourseGrabber.js` 是直接运行在华南理工大学自主选课页面的浏览器脚本。它使用当前页面的登录状态，不处理统一身份认证。

## 使用

1. 登录教务系统，打开自主选课页面。
2. 进入浏览器开发者工具的 Console，粘贴 `scutCourseGrabber.js` 全部内容并执行。
3. 修改脚本顶部的 `TARGET_COURSES`，或在控制台传入目标课程：

```js
scutGrab.start([
  { code: '课程号', priority: 1 },
  { code: '课程名称', priority: 2, timeFilter: ['星期一'], teacherFilter: ['教师姓名'] }
], 5000)
```

4. 查询框中输入的课程号或课程名称需要能在当前选课页面查到。脚本会自动查询、展开教学班、检查 `.rsxx` 余量并点击“选课”。

## 控制

```js
scutGrab.status()
scutGrab.stop()
```

页面出现验证码、重新登录或风控提示时，脚本停止后由人工处理。
