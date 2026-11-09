import { OllamaCatalogueItem, OllamaModel } from './types';

export function getModelCatalogue(installedModels: OllamaModel[] = []): OllamaCatalogueItem[] {
  const installedNames = new Set(installedModels.map((m) => m.name.toLowerCase()));

  const catalogue: Omit<OllamaCatalogueItem, 'installed'>[] = [
    // Coding
    {
      name: 'Qwen 2.5 Coder 7B',
      tag: 'qwen2.5-coder:7b',
      description: 'Premier open coding model. Fast code generation, syntax completion, and multi-file reasoning.',
      category: 'coding',
      parameters: '7B',
      size: '4.7 GB',
      minRamGb: 8,
      popular: true,
      featured: true,
    },
    {
      name: 'Qwen 2.5 Coder 14B',
      tag: 'qwen2.5-coder:14b',
      description: 'Advanced code reasoning, refactoring, and multi-agent coordination capabilities.',
      category: 'coding',
      parameters: '14B',
      size: '9.0 GB',
      minRamGb: 16,
      popular: true,
      featured: true,
    },
    {
      name: 'Qwen 2.5 Coder 32B',
      tag: 'qwen2.5-coder:32b',
      description: 'High-end coding powerhouse comparable to commercial frontier models for complex architectures.',
      category: 'coding',
      parameters: '32B',
      size: '20 GB',
      minRamGb: 32,
    },
    {
      name: 'DeepSeek-Coder-V2 Lite',
      tag: 'deepseek-coder-v2:16b',
      description: 'Mixture-of-Experts architecture supporting 338 programming languages and 128k context.',
      category: 'coding',
      parameters: '16B (2.4B active)',
      size: '8.9 GB',
      minRamGb: 12,
      popular: true,
      featured: true,
    },
    {
      name: 'CodeLlama 7B',
      tag: 'codellama:7b',
      description: 'Meta’s tuned coding model based on Llama 2, reliable for syntax completions and scripts.',
      category: 'coding',
      parameters: '7B',
      size: '3.8 GB',
      minRamGb: 8,
    },
    {
      name: 'CodeLlama 13B',
      tag: 'codellama:13b',
      description: 'Meta’s 13B parameter coding model with strong infilling and Python specialization.',
      category: 'coding',
      parameters: '13B',
      size: '7.4 GB',
      minRamGb: 16,
    },
    {
      name: 'StarCoder2 7B',
      tag: 'starcoder2:7b',
      description: 'BigCode initiative model trained on Software Heritage in 600+ languages.',
      category: 'coding',
      parameters: '7B',
      size: '4.0 GB',
      minRamGb: 8,
    },

    // Reasoning & Critic
    {
      name: 'DeepSeek-R1 8B',
      tag: 'deepseek-r1:8b',
      description: 'State-of-the-art open reasoning model. Exceptional for independent code review and defect detection.',
      category: 'reasoning',
      parameters: '8B',
      size: '4.9 GB',
      minRamGb: 10,
      popular: true,
      featured: true,
    },
    {
      name: 'DeepSeek-R1 14B',
      tag: 'deepseek-r1:14b',
      description: 'High-capability reasoning model for deep architectural validation and security audits.',
      category: 'reasoning',
      parameters: '14B',
      size: '9.0 GB',
      minRamGb: 16,
      popular: true,
    },
    {
      name: 'Qwen 3.8 27B',
      tag: 'qwen3.8:27b',
      description: 'Advanced reasoning and thinking model with native tool-calling and long context support.',
      category: 'reasoning',
      parameters: '27.3B',
      size: '17.7 GB',
      minRamGb: 24,
      popular: true,
      featured: true,
    },

    // General Purpose
    {
      name: 'Llama 3.1 8B',
      tag: 'llama3.1:8b',
      description: 'Fast, efficient instruction-tuned general model with 128k context and function calling.',
      category: 'general',
      parameters: '8B',
      size: '4.7 GB',
      minRamGb: 8,
      popular: true,
    },
    {
      name: 'Llama 3.3 70B',
      tag: 'llama3.3:70b',
      description: 'Top-tier open intelligence model with industry-leading reasoning and instruction adherence.',
      category: 'general',
      parameters: '70B',
      size: '43 GB',
      minRamGb: 64,
    },
    {
      name: 'Mistral 7B Instruct',
      tag: 'mistral:7b',
      description: 'Fast general-purpose model with strong comprehension and structured output capabilities.',
      category: 'general',
      parameters: '7B',
      size: '4.1 GB',
      minRamGb: 8,
    },
    {
      name: 'Gemma 2 9B',
      tag: 'gemma2:9b',
      description: 'Google’s lightweight, state-of-the-art open model with high benchmark performance.',
      category: 'general',
      parameters: '9B',
      size: '5.5 GB',
      minRamGb: 10,
    },

    // Vision
    {
      name: 'Llama 3.2 Vision 11B',
      tag: 'llama3.2-vision:11b',
      description: 'Multimodal model capable of visual reasoning, UI inspection, and diagram understanding.',
      category: 'vision',
      parameters: '11B',
      size: '7.9 GB',
      minRamGb: 16,
    },
    {
      name: 'LLaVA 7B',
      tag: 'llava:7b',
      description: 'Visual assistant capable of interpreting mockups, screenshots, and visual bugs.',
      category: 'vision',
      parameters: '7B',
      size: '4.5 GB',
      minRamGb: 8,
    },
  ];

  return catalogue.map((item) => {
    const isInstalled =
      installedNames.has(item.tag.toLowerCase()) ||
      installedNames.has(item.tag.split(':')[0].toLowerCase()) ||
      installedModels.some((m) => m.name.toLowerCase().startsWith(item.tag.toLowerCase()));
    return {
      ...item,
      installed: isInstalled,
    };
  });
}
