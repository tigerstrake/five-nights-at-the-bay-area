// @fontsource/big-shoulders-display exposes its CSS without the `.css` suffix (no `./*.css` export), which
// TypeScript cannot resolve for side-effect imports. Vite resolves it fine.
declare module '@fontsource/big-shoulders-display/*';
