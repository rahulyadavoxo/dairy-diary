// Global back-button stack for the Android hardware back button.
// Screens push a "close my topmost overlay" function; the Capacitor backButton
// listener pops and runs the topmost one. If the stack is empty, the app exits.
const stack = [];

export function pushBackHandler(fn) {
  stack.push(fn);
  return () => {
    const i = stack.lastIndexOf(fn);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Run the topmost handler. Returns true if one ran. */
export function handleBack() {
  const fn = stack.pop();
  if (fn) {
    fn();
    return true;
  }
  return false;
}
