/** Connects the extension host to the editor and the workbench layout. */
import { activeText, insertAtCursor, selectionInfo } from '../panels/editor/editorService';
import { closeExtensionPanels, openExtensionPanel } from '../workbench/layout';
import { installExtensionListeners, setHostBindings } from './extensionHost';

export function installExtensions(): () => void {
  setHostBindings({
    openPanel: openExtensionPanel,
    closePanels: closeExtensionPanels,
    selection: selectionInfo,
    text: activeText,
    insert: insertAtCursor,
  });
  return installExtensionListeners();
}
