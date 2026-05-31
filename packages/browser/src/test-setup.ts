// React's act() helper expects this global flag in a test environment so it can
// flush effects synchronously without the "not configured to support act"
// notice.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
