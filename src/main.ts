import '@fontsource-variable/space-grotesk';
import './styles/main.css';
import { ensureAccess } from './ui/PassGate';
import { Workspace } from './view/Workspace';
import { buildAppShell } from './ui/AppShell';
import { setupKeyboardShortcuts } from './tools/controller';

// The passcode gate resolves before any of the app UI is built
await ensureAccess();

const app = document.querySelector<HTMLDivElement>('#app')!;
const workspace = new Workspace();
// A second viewer for the split pane — duplicates the active page, with its
// own independent zoom level
const secondaryWorkspace = new Workspace(true);
const shell = buildAppShell(workspace, secondaryWorkspace);

const primaryPane = shell.querySelector('.viewer-pane.primary') as HTMLElement;
workspace.mount(primaryPane);

app.appendChild(shell);
setupKeyboardShortcuts();
