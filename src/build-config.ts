import clashTemplate from './clash.yaml';
import yaml from 'js-yaml';

/** 模板里的代理组：本流程只读写 use / filter / exclude-filter / proxies */
interface TemplateProxyGroup {
  name?: string;
  use?: string[];
  filter?: string;
  'exclude-filter'?: string;
  proxies?: string[];
}

interface TemplateConfig {
  /** 上游节点原样透传，只有 name 会被读取 */
  proxies?: unknown[];
  'proxy-groups'?: TemplateProxyGroup[];
  'proxy-providers'?: unknown;
  [key: string]: unknown;
}

/** 把 use 组展开成显式节点列表；过滤为空时删除该组，避免空组 */
const materializeGroup = (group: TemplateProxyGroup, proxyNames: string[]): TemplateProxyGroup | null => {
  if (!group.use) return group;

  delete group.use;

  const excludeFilter = group['exclude-filter'];
  delete group['exclude-filter'];

  if (!group.filter) {
    group.proxies = [...proxyNames];
    return group;
  }

  // JS 不支持内联 (?i)，大小写不敏感改用 flags
  const regex = new RegExp(group.filter.replace(/\(\?i\)/g, ''), 'i');
  const excludeRegex = excludeFilter ? new RegExp(excludeFilter.replace(/\(\?i\)/g, ''), 'i') : null;
  const matched = proxyNames.filter((name) => regex.test(name) && !(excludeRegex !== null && excludeRegex.test(name)));

  // 例如某地区只剩高倍率节点时，该组已无可用节点
  if (matched.length === 0) {
    console.warn(`proxy group "${group.name}" matched no node, dropping it`);
    return null;
  }

  group.proxies = matched;
  return group;
};

/** 把合并后的节点写进模板，展开分组并输出自包含配置 */
export const buildClashConfig = (proxies: unknown[], proxyNames: string[]): string => {
  const templateConfig = yaml.load(clashTemplate) as TemplateConfig;
  templateConfig.proxies = proxies;

  const groups = templateConfig['proxy-groups'] ?? [];
  const materialized = groups.map((group) => materializeGroup(group, proxyNames));

  // 被删除的分组不能继续出现在其它分组的 proxies 列表里（例如 PROXY 里的 HK_AUTO）
  const droppedNames = new Set<string>();
  groups.forEach((group, index) => {
    if (materialized[index] === null && group.name) droppedNames.add(group.name);
  });

  const keptGroups = materialized.filter((group): group is TemplateProxyGroup => group !== null);
  if (droppedNames.size > 0) {
    for (const group of keptGroups) {
      if (group.proxies) {
        group.proxies = group.proxies.filter((name) => !droppedNames.has(name));
      }
    }
  }

  templateConfig['proxy-groups'] = keptGroups;

  delete templateConfig['proxy-providers'];

  return yaml.dump(templateConfig);
};
