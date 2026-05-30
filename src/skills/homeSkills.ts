export interface HomeSkill {
  id: string;
  label: string;
  skillPath: string;
  description: string;
  prompt: string;
}

export const HOME_SKILLS: HomeSkill[] = [
  {
    id: 'chat',
    label: '智能对话',
    skillPath: 'smart-chat',
    description: '结合工作区、选区和上下文进行通用研发对话。',
    prompt: '',
  },
  {
    id: 'generate',
    label: '代码生成',
    skillPath: 'code-generation',
    description: '按项目约定生成或修改代码。',
    prompt:
      '使用 skill_view 加载 code-generation 技能，并遵循其中的工作流。\n\n' +
      '请根据下面任务生成代码，匹配项目现有约定、类型和导入方式，优先修改最少必要文件。\n\n任务：',
  },
  {
    id: 'review',
    label: '代码审查',
    skillPath: 'code-review',
    description: '审查选中代码或已打开文件，输出结构化问题。',
    prompt:
      '使用 skill_view 加载 code-review 技能，并遵循其中的工作流。\n\n' +
      '请审查选中的代码或当前打开的文件，按技能要求的格式报告发现的问题。',
  },
  {
    id: 'explain',
    label: '代码解释',
    skillPath: 'explain-code',
    description: '用清晰语言解释代码行为、数据流和关键设计。',
    prompt:
      '使用 skill_view 加载 explain-code 技能，并遵循其中的工作流。\n\n' +
      '请为当前代码库开发者解释选中的代码或当前打开的文件。',
  },
  {
    id: 'tests',
    label: '生成测试',
    skillPath: 'generate-tests',
    description: '基于项目现有测试框架和模式生成测试。',
    prompt:
      '使用 skill_view 加载 generate-tests 技能，并遵循其中的工作流。\n\n' +
      '请为选中的代码或当前打开的文件生成测试，使用项目现有测试框架和风格。',
  },
  {
    id: 'docs',
    label: '生成文档',
    skillPath: 'document-generation',
    description: '为 API、模块或关键逻辑生成符合项目风格的文档。',
    prompt:
      '使用 skill_view 加载 document-generation 技能，并遵循其中的工作流。\n\n' +
      '请为选中的代码或当前打开的文件生成文档，匹配项目现有文档风格。',
  },
];

export function homeSkillById(id: string): HomeSkill | undefined {
  return HOME_SKILLS.find(s => s.id === id);
}
