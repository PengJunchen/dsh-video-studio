// Harness's browser bundle contract: resolve React from the Host's module
// table so the plugin never ships a second renderer or runtime instance.
window.__ModuleLoader__.load({
  id: 'dsh-video-studio',
  factory(require) {
    const { createElement: h } = require('react');
    const panelId = 'hvp-studio';

    function StudioPanel() {
      // The same-origin route keeps the Host's authentication and source
      // grants. Electron forwards it through its owned dsh-app protocol.
      return h('iframe', {
        title: '影调工作台',
        src: '/hvp/',
        style: { display: 'block', width: '100%', height: '100%', minHeight: 0, border: 0, background: '#f5f3ef' },
      });
    }

    function StudioIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M12 4v16M3 12h18', stroke: 'currentColor', strokeWidth: 1.6 }),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panelId }, StudioPanel));
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist', id: panelId, order: 20, label: () => '影调工作台',
      }, StudioIcon));
      ctx.effect(() => () => {
        if (ctx.layout.panelInfo.getSnapshot().activePanelId === panelId) ctx.layout.selectPanel(null);
      }, 'video Studio panel navigation cleanup');
    }

    return { name: 'video-studio-client', inject: ['slots', 'layout'], apply };
  },
});
