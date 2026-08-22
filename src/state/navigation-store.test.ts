import { beforeEach, describe, expect, it } from 'vitest';

import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  resetNavigationStore,
  useNavigationStore,
} from './navigation-store';

beforeEach(() => {
  resetNavigationStore();
});

describe('navigation store', () => {
  it('opens with nothing selected and the palette closed', () => {
    const state = useNavigationStore.getState();
    expect(state.selectedConversationId).toBeNull();
    expect(state.paletteMode).toBe('closed');
    expect(state.sidebarWidth).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it('clamps a width on the way in, matching what the host would store', () => {
    // The drag handle reads this back every frame, so an unclamped value would
    // render before the host ever saw it and then snap when the write returns.
    const { setSidebarWidth } = useNavigationStore.getState();
    setSidebarWidth(9999);
    expect(useNavigationStore.getState().sidebarWidth).toBe(MAX_SIDEBAR_WIDTH);
    setSidebarWidth(-40);
    expect(useNavigationStore.getState().sidebarWidth).toBe(MIN_SIDEBAR_WIDTH);
    setSidebarWidth(301.6);
    expect(useNavigationStore.getState().sidebarWidth).toBe(302);
  });

  it('survives a width that is not a number at all', () => {
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });

  it('keeps the width when collapsing, so expanding restores it', () => {
    const { setSidebarWidth, toggleSidebar } = useNavigationStore.getState();
    setSidebarWidth(360);
    toggleSidebar();

    expect(useNavigationStore.getState().sidebarCollapsed).toBe(true);
    expect(useNavigationStore.getState().sidebarWidth).toBe(360);

    useNavigationStore.getState().toggleSidebar();
    expect(useNavigationStore.getState().sidebarCollapsed).toBe(false);
    expect(useNavigationStore.getState().sidebarWidth).toBe(360);
  });

  it('opens the palette in either mode and closes it', () => {
    const { openPalette, closePalette } = useNavigationStore.getState();
    openPalette('switcher');
    expect(useNavigationStore.getState().paletteMode).toBe('switcher');
    openPalette('search');
    expect(useNavigationStore.getState().paletteMode).toBe('search');
    closePalette();
    expect(useNavigationStore.getState().paletteMode).toBe('closed');
  });

  it('selects and deselects a conversation', () => {
    const { select } = useNavigationStore.getState();
    select('conv_1');
    expect(useNavigationStore.getState().selectedConversationId).toBe('conv_1');
    select(null);
    expect(useNavigationStore.getState().selectedConversationId).toBeNull();
  });
});
