import { isTauriDesktop } from '@/utils/platform/tauri';
import { isWebDocumentActivelyViewed } from '@/utils/runtime/isWebDocumentActivelyViewed';

export function isTauriMainWindowActivelyViewed(): boolean {
    return isTauriDesktop() && isWebDocumentActivelyViewed();
}
