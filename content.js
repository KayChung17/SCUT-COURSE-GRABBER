(() => {
  if (window.top !== window) {
    return;
  }

  const marker = "data-scut-course-grabber";
  if (document.querySelector(`script[${marker}]`)) {
    return;
  }

  const script = document.createElement("script");
  script.setAttribute(marker, "true");
  script.src = chrome.runtime.getURL("courseGrabber.js");
  script.addEventListener("load", () => script.remove());
  (document.head || document.documentElement).appendChild(script);
})();
