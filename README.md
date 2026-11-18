# Build your own React

- **Category**: Front-end Framework / Library
- **Language**: JavaScript (zero external dependencies)
- **Original Tutorial**: [Build your own React — Rodrigo Pombo](https://pomb.us/build-your-own-react/)

## Architecture & Core Mechanics

1. **Fiber Tree & Incremental Work Loop (`workLoop`, `performUnitOfWork`)**:
   - Breaks rendering into interruptible Fiber units connected via `parent`, `child`, `sibling`, and `alternate` links.
2. **Reconciliation & Single-Pass Atomic Commit (`reconcileChildren`, `commitRoot`, `commitWork`)**:
   - Tags Fibers with `PLACEMENT`, `UPDATE`, or `DELETION` during render without touching the DOM until `commitRoot()` applies all mutations atomically.
3. **Function Components & Hooks (`useState`, `useEffect`)**:
   - Stores hook cells per Fiber index across renders, processes functional updater queues, compares dependency arrays with `Object.is`, and executes cleanup callbacks on dependency changes or fiber deletion.

## How to Run

- **Node.js self-test**: `node main.js`
- **Browser UI**: Open `index.html`.
