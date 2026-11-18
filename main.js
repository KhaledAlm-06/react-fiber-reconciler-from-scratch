"use strict";

/**
 * Build Your Own React (pomb.us/build-your-own-react/)
 * Faithful Fiber Reconciler with Time-Slicing, Render/Commit Phases & Hooks (`useState`, `useEffect`).
 *
 * Implements:
 * - `createElement` + `createTextElement`
 * - Incremental Fiber tree (`parent`, `child`, `sibling`, `alternate`, `effectTag`)
 * - Time-sliced `workLoop(deadline)` (`requestIdleCallback` / scheduler + synchronous test flush)
 * - Atomic `commitRoot()` + `commitWork()` + `commitDeletion()`
 * - Function components + `useState` action queue + `useEffect` dependency diff & cleanup
 */

(function (root) {
  function createMockDOM() {
    class MockNode {
      constructor(t) { this.nodeType = t; this.childNodes = []; this.parentNode = null; }
      appendChild(c) {
        if (c.parentNode) c.parentNode.removeChild(c);
        c.parentNode = this;
        this.childNodes.push(c);
        return c;
      }
      removeChild(c) {
        const i = this.childNodes.indexOf(c);
        if (i !== -1) { this.childNodes.splice(i, 1); c.parentNode = null; }
        return c;
      }
    }
    class MockText extends MockNode {
      constructor(v) { super(3); this.nodeValue = String(v); }
      toHTML() { return this.nodeValue; }
    }
    class MockElement extends MockNode {
      constructor(tag) {
        super(1);
        this.tagName = tag.toLowerCase();
        this.attributes = {};
        this.listeners = {};
        this.style = {};
      }
      setAttribute(k, v) { this.attributes[k] = String(v); }
      addEventListener(e, fn) {
        this.listeners[e] = this.listeners[e] || [];
        this.listeners[e].push(fn);
      }
      removeEventListener(e, fn) {
        if (this.listeners[e]) this.listeners[e] = this.listeners[e].filter((f) => f !== fn);
      }
      dispatchEvent(evt) {
        for (const fn of (this.listeners[evt.type] || []).slice()) fn(evt);
      }
      toHTML() {
        const attrs = [];
        for (const [k, v] of Object.entries(this)) {
          if (["nodeType", "childNodes", "parentNode", "tagName", "attributes", "listeners", "style"].includes(k)) continue;
          if (v !== undefined && v !== null) attrs.push(`${k === "className" ? "class" : k}="${v}"`);
        }
        const attrStr = attrs.length ? " " + attrs.join(" ") : "";
        return `<${this.tagName}${attrStr}>${this.childNodes.map((c) => c.toHTML()).join("")}</${this.tagName}>`;
      }
    }
    return {
      createElement: (t) => new MockElement(t),
      createTextNode: (v) => new MockText(v),
    };
  }

  let docRef = typeof document !== "undefined" ? document : createMockDOM();

  function createElement(type, props, ...children) {
    const flat = [].concat(...children).filter((c) => c !== null && c !== undefined && typeof c !== "boolean");
    return {
      type,
      props: Object.assign({}, props || {}, {
        children: flat.map((child) => (typeof child === "object" ? child : createTextElement(child))),
      }),
    };
  }

  function createTextElement(text) {
    return {
      type: "TEXT_ELEMENT",
      props: { nodeValue: String(text), children: [] },
    };
  }

  const isEvent = (key) => key.startsWith("on");
  const isProperty = (key) => key !== "children" && !isEvent(key);
  const isNew = (prev, next) => (key) => prev[key] !== next[key];
  const isGone = (prev, next) => (key) => !(key in next);

  function createDom(fiber) {
    const dom =
      fiber.type === "TEXT_ELEMENT"
        ? docRef.createTextNode("")
        : docRef.createElement(fiber.type);
    updateDom(dom, {}, fiber.props);
    return dom;
  }

  function updateDom(dom, prevProps, nextProps) {
    Object.keys(prevProps)
      .filter(isEvent)
      .filter((key) => !(key in nextProps) || isNew(prevProps, nextProps)(key))
      .forEach((name) => {
        const eventType = name.toLowerCase().substring(2);
        dom.removeEventListener(eventType, prevProps[name]);
      });

    Object.keys(prevProps)
      .filter(isProperty)
      .filter(isGone(prevProps, nextProps))
      .forEach((name) => {
        dom[name] = "";
      });

    Object.keys(nextProps)
      .filter(isProperty)
      .filter(isNew(prevProps, nextProps))
      .forEach((name) => {
        if (name === "style" && typeof nextProps[name] === "object") {
          Object.assign(dom.style, nextProps[name]);
        } else {
          dom[name] = nextProps[name];
        }
      });

    Object.keys(nextProps)
      .filter(isEvent)
      .filter(isNew(prevProps, nextProps))
      .forEach((name) => {
        const eventType = name.toLowerCase().substring(2);
        dom.addEventListener(eventType, nextProps[name]);
      });
  }

  let nextUnitOfWork = null;
  let currentRoot = null;
  let wipRoot = null;
  let deletions = null;
  let wipFiber = null;
  let hookIndex = null;
  let pendingEffects = [];
  let workUnitsProcessed = 0;

  function scheduleWork() {
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(workLoop);
    } else {
      // Microtask/immediate fallback for headless Node or Safari without dangling timers
      Promise.resolve().then(() => workLoop({ timeRemaining: () => 50 }));
    }
  }

  function flushSync() {
    while (nextUnitOfWork) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
      workUnitsProcessed++;
    }
    if (wipRoot) commitRoot();
  }

  function render(element, container, customDoc) {
    if (customDoc) docRef = customDoc;
    wipRoot = {
      dom: container,
      props: { children: [element] },
      alternate: currentRoot,
    };
    deletions = [];
    nextUnitOfWork = wipRoot;
    if (typeof document === "undefined") {
      // Deterministic synchronous flush in headless environments unless testing time-slicing manually
      flushSync();
    } else {
      scheduleWork();
    }
  }

  function workLoop(deadline) {
    let shouldYield = false;
    while (nextUnitOfWork && !shouldYield) {
      nextUnitOfWork = performUnitOfWork(nextUnitOfWork);
      workUnitsProcessed++;
      shouldYield = deadline.timeRemaining() < 1;
    }
    if (!nextUnitOfWork && wipRoot) {
      commitRoot();
    }
    if (nextUnitOfWork) {
      scheduleWork();
    }
  }

  function commitRoot() {
    deletions.forEach(commitWork);
    commitWork(wipRoot.child);
    currentRoot = wipRoot;
    wipRoot = null;
    // Flush effects after DOM commit
    const effects = pendingEffects.splice(0, pendingEffects.length);
    for (const eff of effects) {
      if (eff.prevCleanup) eff.prevCleanup();
      const cleanup = eff.effectFn();
      if (typeof cleanup === "function") eff.hook.cleanup = cleanup;
    }
  }

  function commitWork(fiber) {
    if (!fiber) return;
    let domParentFiber = fiber.parent;
    while (!domParentFiber.dom) {
      domParentFiber = domParentFiber.parent;
    }
    const domParent = domParentFiber.dom;

    if (fiber.effectTag === "PLACEMENT" && fiber.dom != null) {
      domParent.appendChild(fiber.dom);
    } else if (fiber.effectTag === "UPDATE" && fiber.dom != null) {
      updateDom(fiber.dom, fiber.alternate.props, fiber.props);
    } else if (fiber.effectTag === "DELETION") {
      commitDeletion(fiber, domParent);
      return;
    }

    commitWork(fiber.child);
    commitWork(fiber.sibling);
  }

  function commitDeletion(fiber, domParent) {
    if (fiber.hooks) {
      for (const h of fiber.hooks) {
        if (h.tag === "effect" && typeof h.cleanup === "function") h.cleanup();
      }
    }
    if (fiber.dom) {
      domParent.removeChild(fiber.dom);
    } else if (fiber.child) {
      commitDeletion(fiber.child, domParent);
    }
  }

  function performUnitOfWork(fiber) {
    const isFunctionComponent = fiber.type instanceof Function;
    if (isFunctionComponent) {
      updateFunctionComponent(fiber);
    } else {
      updateHostComponent(fiber);
    }
    if (fiber.child) return fiber.child;
    let nextFiber = fiber;
    while (nextFiber) {
      if (nextFiber.sibling) return nextFiber.sibling;
      nextFiber = nextFiber.parent;
    }
    return null;
  }

  function updateFunctionComponent(fiber) {
    wipFiber = fiber;
    hookIndex = 0;
    wipFiber.hooks = [];
    const children = [fiber.type(fiber.props)];
    reconcileChildren(fiber, children);
  }

  function updateHostComponent(fiber) {
    if (!fiber.dom) {
      fiber.dom = createDom(fiber);
    }
    reconcileChildren(fiber, fiber.props.children);
  }

  function reconcileChildren(wipFiberNode, elements) {
    let index = 0;
    let oldFiber = wipFiberNode.alternate && wipFiberNode.alternate.child;
    let prevSibling = null;

    while (index < elements.length || oldFiber != null) {
      const element = elements[index];
      let newFiber = null;
      const sameType = oldFiber && element && element.type === oldFiber.type;

      if (sameType) {
        newFiber = {
          type: oldFiber.type,
          props: element.props,
          dom: oldFiber.dom,
          parent: wipFiberNode,
          alternate: oldFiber,
          effectTag: "UPDATE",
        };
      }
      if (element && !sameType) {
        newFiber = {
          type: element.type,
          props: element.props,
          dom: null,
          parent: wipFiberNode,
          alternate: null,
          effectTag: "PLACEMENT",
        };
      }
      if (oldFiber && !sameType) {
        oldFiber.effectTag = "DELETION";
        deletions.push(oldFiber);
      }

      if (oldFiber) oldFiber = oldFiber.sibling;
      if (index === 0) wipFiberNode.child = newFiber;
      else if (element && prevSibling) prevSibling.sibling = newFiber;
      prevSibling = newFiber;
      index++;
    }
  }

  function useState(initial) {
    const oldHook =
      wipFiber.alternate &&
      wipFiber.alternate.hooks &&
      wipFiber.alternate.hooks[hookIndex];
    const hook = {
      tag: "state",
      state: oldHook ? oldHook.state : (typeof initial === "function" ? initial() : initial),
      queue: [],
    };
    const actions = oldHook ? oldHook.queue : [];
    actions.forEach((action) => {
      hook.state = typeof action === "function" ? action(hook.state) : action;
    });

    const setState = (action) => {
      hook.queue.push(action);
      wipRoot = {
        dom: currentRoot.dom,
        props: currentRoot.props,
        alternate: currentRoot,
      };
      nextUnitOfWork = wipRoot;
      deletions = [];
      if (typeof document === "undefined") flushSync();
      else scheduleWork();
    };

    wipFiber.hooks.push(hook);
    hookIndex++;
    return [hook.state, setState];
  }

  function useEffect(effectFn, deps) {
    const oldHook =
      wipFiber.alternate &&
      wipFiber.alternate.hooks &&
      wipFiber.alternate.hooks[hookIndex];
    const hasChanged = !oldHook || !deps || !oldHook.deps ||
      deps.length !== oldHook.deps.length ||
      deps.some((d, i) => !Object.is(d, oldHook.deps[i]));

    const hook = {
      tag: "effect",
      deps,
      cleanup: oldHook ? oldHook.cleanup : undefined,
    };
    if (hasChanged) {
      pendingEffects.push({
        hook,
        effectFn,
        prevCleanup: oldHook ? oldHook.cleanup : undefined,
      });
    }
    wipFiber.hooks.push(hook);
    hookIndex++;
  }

  function reset() {
    nextUnitOfWork = null;
    currentRoot = null;
    wipRoot = null;
    deletions = null;
    pendingEffects = [];
    workUnitsProcessed = 0;
  }

  function runSelfTests() {
    const assert = (c, m) => { if (!c) throw new Error("Assertion failed: " + m); };
    const mockDoc = createMockDOM();
    const container = mockDoc.createElement("div");
    reset();

    const effectEvents = [];
    function ChildBadge({ count }) {
      useEffect(() => {
        effectEvents.push(`mountOrUpdate:${count}`);
        return () => effectEvents.push(`cleanup:${count}`);
      }, [count]);
      return createElement("span", { id: "badge" }, `Value=${count}`);
    }

    function App() {
      const [count, setCount] = useState(1);
      const [show, setShow] = useState(true);
      return createElement(
        "main",
        null,
        createElement("button", { id: "inc", onClick: () => setCount((c) => c + 1) }, "+1"),
        createElement("button", { id: "tog", onClick: () => setShow((s) => !s) }, "Toggle"),
        show ? createElement(ChildBadge, { count }) : null
      );
    }

    render(createElement(App, null), container, mockDoc);
    assert(container.toHTML().includes("Value=1"), "Initial Fiber render committed ChildBadge");
    assert(effectEvents.join(",") === "mountOrUpdate:1", "Initial useEffect executed after commit");

    // Trigger functional setState twice -> updates count 1 -> 2 -> 3
    const mainEl = container.childNodes[0];
    mainEl.childNodes[0].dispatchEvent({ type: "click" });
    mainEl.childNodes[0].dispatchEvent({ type: "click" });
    assert(container.toHTML().includes("Value=3"), "Functional useState updates advanced count to 3");
    assert(effectEvents.includes("cleanup:1") && effectEvents.includes("mountOrUpdate:3"),
      "useEffect dependency cleanup ran before re-running effect");

    // Toggle conditional child off -> DELETION commits cleanup + removes DOM node
    mainEl.childNodes[1].dispatchEvent({ type: "click" });
    assert(!container.toHTML().includes("badge"), "Conditional child removed on DELETION fiber");
    assert(effectEvents[effectEvents.length - 1] === "cleanup:3", "Unmount cleanup executed on fiber deletion");

    // Time-slicing workLoop simulation with yielded deadline
    wipRoot = { dom: container, props: { children: [createElement("p", null, "Sliced")] }, alternate: currentRoot };
    deletions = [];
    nextUnitOfWork = wipRoot;
    let ticks = 0;
    workLoop({ timeRemaining: () => (ticks++ === 0 ? 0 : 10) }); // yield on 1st unit
    assert(wipRoot !== null && nextUnitOfWork !== null, "workLoop yielded after 1st unit");
    flushSync();
    assert(container.toHTML().includes("Sliced"), "Yielding workLoop resumed and committed Fiber tree");

    return { units: workUnitsProcessed, effects: effectEvents.length, html: container.toHTML() };
  }

  root.PombUsDidact = {
    createElement,
    render,
    useState,
    useEffect,
    flushSync,
    reset,
    createMockDOM,
    runSelfTests,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = root.PombUsDidact;
  }

  if (typeof document === "undefined" && typeof require !== "undefined" && require.main === module) {
    const res = runSelfTests();
    console.log("=== Build Your Own React (pomb.us Fiber + Hooks) Self-Test ===");
    console.log("[PASS] Time-sliced Fiber loop, commitRoot, useState & useEffect cleanups verified.");
    console.log(`Fiber units processed=${res.units}, effect transitions=${res.effects}`);
  }
})(typeof window !== "undefined" ? window : globalThis);
