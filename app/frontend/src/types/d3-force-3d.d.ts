// d3-force-3d ships without bundled TypeScript types. We only use a couple of
// force factories (e.g. forceCollide) via the react-force-graph canvas, so a
// permissive module declaration is sufficient.
declare module "d3-force-3d";
