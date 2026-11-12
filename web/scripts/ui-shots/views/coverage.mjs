// The exhaustive inventory (--coverage): its scenarios and how each opens are in ui-shots-coverage.mjs.
import { coverageViews, openCoverageView } from '../../ui-shots-coverage.mjs';
import { askHeader } from './helpers.mjs';

export default Object.entries(coverageViews).map(([name, device]) => ({
  name,
  ...device,
  open: (page, { url, rich, options }) => openCoverageView(page, url, name, rich, askHeader, options.assets),
}));
