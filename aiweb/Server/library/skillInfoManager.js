/**
 * SKILL 信息管理器
 * 
 * 提供代码检视相关的 SKILL 元数据管理,包括:
 * - SKILL 基本信息(名称、描述、版本)
 * - 核心检视维度说明
 * - 工作流程概览
 * - SKILL 文档路径解析
 * 
 * 设计原则:
 * - 高内聚:所有SKILL信息管理逻辑集中于此模块
 * - 低耦合:通过标准化接口对外提供服务,易于扩展新的SKILL类型
 * - 可配置:SKILL元数据通过配置文件管理,便于维护和更新
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createLogger } from './logger.js';

const logger = createLogger('SkillInfoManager');

/**
 * SKILL 元数据配置(简化版)
 * 
 * 每个SKILL仅包含核心基本信息:
 * - id:唯一标识符
 * - name:展示名称
 * - description:简短描述(用于前端卡片展示)
 * - skillPath:SKILL.md文件所在目录(用于文档预览)
 * - libraryType:适用的三方库类型(用于分类显示)
 * - version:版本号(用于文档展示)
 * - author:作者(用于文档展示)
 */
const SKILL_CONFIGS = {
  // ─── 代码检视类 SKILL ───────────────────────────────────────────
  'arkts-code-check': {
    id: 'arkts-code-check',
    name: 'ArkTS 代码检视',
    description: '自动化检视 ArkTS 三方库 Pull Request，深度分析代码变更，生成结构化检视报告',
    skillPath: 'ArkTsCodeCheckSkill',
    libraryType: 'arkts',
    version: '2.0',
    author: 'CPPAgent',
  },

  'flutter-code-check': {
    id: 'flutter-code-check',
    name: 'Flutter 代码检视',
    description: '检视 Flutter 三方库 PR，重点审查 ohos/ 目录下的鸿蒙平台实现代码',
    skillPath: 'FlutterCodeCheck',
    libraryType: 'flutter',
    version: '2.0',
    author: 'CPPAgent',
  },

  'rn-code-check': {
    id: 'rn-code-check',
    name: 'React Native 代码检视',
    description: '检视 React Native 三方库 PR，重点检查 harmony/ 目录下的 CAPI/ArkTS 代码的线程安全与内存管理',
    skillPath: 'RNCodeCheck',
    libraryType: 'rn',
    version: '1.0',
    author: 'CPPAgent',
  },

  'tpc-check': {
    id: 'tpc-check',
    name: 'TPC C/C++ 规范性检视',
    description: '检视 tpc_c_cplusplus 仓库适配库 PR 的规范性，包括编译脚本(HPKBUILD)、文档格式、目录结构等',
    skillPath: 'TpcCheck',
    libraryType: 'tpccplus',
    version: '2.0',
    author: 'CPPAgent',
  },


  // ─── Flutter 仓库检视类 SKILL ───────────────────────────────────────
  'library-interface-analyzer': {
    id: 'library-interface-analyzer',
    name: 'Flutter 接口规格分析',
    description: '分析 Flutter 三方库鸿蒙化的公开接口规格，提取导出的类、接口、函数和变量，生成结构化的接口规格说明文档',
    skillPath: 'LibraryInterface',
    libraryType: 'flutter-library',
    version: '1.4',
    author: 'CPPAgent',
  },

  'flutter-library-code-quality-check': {
    id: 'flutter-library-code-quality-check',
    name: 'Flutter 编码质量检视',
    description: '对 Flutter 三方库的鸿蒙化代码进行编码质量检视，依据华为官方编程规范进行评分',
    skillPath: 'FlutterLibraryCodeQualityCheckSkill',
    libraryType: 'flutter-library',
    version: '2.1',
    author: 'CPPAgent',
  },

  'flutter-library-consistency-check': {
    id: 'flutter-library-consistency-check',
    name: 'Flutter 一致性检视',
    description: '检查 Flutter 三方库鸿蒙化实现与 Dart 接口层的一致性，验证功能对齐和接口完整性',
    skillPath: 'FlutterLibraryConsistencyCheckSkill',
    libraryType: 'flutter-library',
    version: '2.0',
    author: 'CPPAgent',
  },

  'flutter-library-documentation-quality-check': {
    id: 'flutter-library-documentation-quality-check',
    name: 'Flutter 文档质量检视',
    description: '检视 Flutter 三方库鸿蒙化代码的文档质量，评估注释完整性和API文档规范',
    skillPath: 'FlutterLibraryDocumentationQualityCheckSkill',
    libraryType: 'flutter-library',
    version: '2.0',
    author: 'CPPAgent',
  },

  'flutter-library-memory-leak-check': {
    id: 'flutter-library-memory-leak-check',
    name: 'Flutter 内存泄露检视',
    description: '专项检查 Flutter 三方库鸿蒙化代码的内存管理，识别潜在的内存泄露风险',
    skillPath: 'FlutterLibraryMemoryLeakCheckSkill',
    libraryType: 'flutter-library',
    version: '2.0',
    author: 'CPPAgent',
  },

  'flutter-library-stability-check': {
    id: 'flutter-library-stability-check',
    name: 'Flutter 稳定性检视',
    description: '检查 Flutter 三方库鸿蒙化代码的稳定性，识别崩溃风险和异常处理缺陷',
    skillPath: 'FlutterLibraryStabilityCheckSkill',
    libraryType: 'flutter-library',
    version: '2.0',
    author: 'CPPAgent',
  },

  'flutter-library-test-coverage-check': {
    id: 'flutter-library-test-coverage-check',
    name: 'Flutter 用例覆盖度检视',
    description: '评估 Flutter 三方库鸿蒙化代码的测试覆盖率，验证关键功能的测试完整性',
    skillPath: 'FlutterLibraryTestCoverageCheckSkill',
    libraryType: 'flutter-library',
    version: '2.0',
    author: 'CPPAgent',
  },

  // ─── ArkTS 仓库检视类 SKILL ───────────────────────────────────────────
  'arkts-library-interface-check': {
    id: 'arkts-library-interface-check',
    name: 'ArkTS 接口分析',
    description: '分析 ArkTS 鸿蒙化库的公开接口规格，生成接口规格说明文档',
    skillPath: 'LibraryInterface',
    libraryType: 'arkts-library',
    version: '2.0',
    author: 'CPPAgent',
  },

  'arkts-library-stability-check': {
    id: 'arkts-library-stability-check',
    name: 'ArkTS 稳定性检视',
    description: '检查 ArkTS 鸿蒙化库的稳定性，识别崩溃风险和异常处理缺陷',
    skillPath: 'ArktsLibraryStabilityCheckSkill',
    libraryType: 'arkts-library',
    version: '2.0',
    author: 'CPPAgent',
  },

  'arkts-library-code-quality-check': {
    id: 'arkts-library-code-quality-check',
    name: 'ArkTS 编码质量检视',
    description: '对 ArkTS 鸿蒙化库的代码进行编码质量检视，依据华为官方编程规范进行评分',
    skillPath: 'ArktsLibraryCodeQualityCheckSkill',
    libraryType: 'arkts-library',
    version: '2.0',
    author: 'CPPAgent',
  },

  'arkts-library-memory-leak-check': {
    id: 'arkts-library-memory-leak-check',
    name: 'ArkTS 内存泄露检视',
    description: '专项检查 ArkTS 鸿蒙化库的内存管理，识别潜在的内存泄露风险',
    skillPath: 'ArktsLibraryMemoryLeakCheckSkill',
    libraryType: 'arkts-library',
    version: '2.0',
    author: 'CPPAgent',
  },

  'arkts-library-documentation-quality-check': {
    id: 'arkts-library-documentation-quality-check',
    name: 'ArkTS 文档质量检视',
    description: '检视 ArkTS 鸿蒙化库的文档质量，评估文档完整性、准确性和鸿蒙化说明充分性',
    skillPath: 'ArktsLibraryDocumentationQualityCheckSkill',
    libraryType: 'arkts-library',
    version: '2.0',
    author: 'CPPAgent',
  },

  'arkts-library-test-coverage-check': {
    id: 'arkts-library-test-coverage-check',
    name: 'ArkTS 用例覆盖度检视',
    description: '评估 ArkTS 鸿蒙化库的测试覆盖率，验证关键功能的测试完整性',
    skillPath: 'ArktsLibraryTestCoverageCheckSkill',
    libraryType: 'arkts-library',
    version: '2.0',
    author: 'CPPAgent',
  },

  // ─── RN 仓库检视类 SKILL ────────────────────────────────────────────────
  'rn-library-interface-check': {
    id: 'rn-library-interface-check',
    name: 'RN 接口规格分析',
    description: '下载鸿蒙化与上游原库代码，对比分析 React Native 三方库鸿蒙化的接口规格',
    skillPath: 'RNLibraryInterfaceAnalyzer',
    libraryType: 'rn-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'rn-library-stability-check': {
    id: 'rn-library-stability-check',
    name: 'RN 稳定性检视',
    description: '检查 React Native 鸿蒙化代码的稳定性，识别崩溃风险和异常处理缺陷',
    skillPath: 'RNLibraryStabilityCheckSkill',
    libraryType: 'rn-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'rn-library-consistency-check': {
    id: 'rn-library-consistency-check',
    name: 'RN 一致性检视',
    description: '对比鸿蒙化接口实现与上游库 Android/iOS 平台实现的一致性，检测差异和潜在问题',
    skillPath: 'RNLibraryConsistencyCheckSkill',
    libraryType: 'rn-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'rn-library-code-quality-check': {
    id: 'rn-library-code-quality-check',
    name: 'RN 编码质量检视',
    description: '对 React Native 鸿蒙化代码进行编码质量检视，分析潜在问题和改进建议',
    skillPath: 'RNLibraryCodeQualityCheckSkill',
    libraryType: 'rn-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'rn-library-memory-leak-check': {
    id: 'rn-library-memory-leak-check',
    name: 'RN 内存泄露检视',
    description: '专项检查 React Native 鸿蒙化代码的内存泄露风险',
    skillPath: 'RNLibraryMemoryLeakCheckSkill',
    libraryType: 'rn-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'rn-library-documentation-quality-check': {
    id: 'rn-library-documentation-quality-check',
    name: 'RN 文档质量检视',
    description: '检视 React Native 鸿蒙化库的文档质量，评估文档完整性、准确性和易读性',
    skillPath: 'RNLibraryDocumentationQualityCheckSkill',
    libraryType: 'rn-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'rn-library-test-coverage-check': {
    id: 'rn-library-test-coverage-check',
    name: 'RN 用例覆盖度检视',
    description: '评估 React Native 鸿蒙化代码的测试用例覆盖情况',
    skillPath: 'RNLibraryTestCoverageCheckSkill',
    libraryType: 'rn-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  // ─── 文档修改类 SKILL ──────────────────────────────────────────────────
  'library-doc-fix': {
    id: 'library-doc-fix',
    name: '三方库文档修改',
    description: 'Fork GitCode 仓库，自动修改不规范文档，提交代码并创建 PR，评论 Start build',
    skillPath: 'LibraryDocFixSkill',
    libraryType: 'doc-fix',
    version: '1.0',
    author: 'CPPAgent',
  },

  // ─── KMP 仓库检视类 SKILL ───────────────────────────────────────────────
  'kmp-library-interface-analyzer': {
    id: 'kmp-library-interface-analyzer',
    name: 'KMP 接口规格分析',
    description: '分析 KMP 三方库鸿蒙化的公开接口规格，提取导出的类、接口、函数和变量，生成结构化的接口规格说明文档',
    skillPath: 'KMPLibraryInterfaceAnalyzer',
    libraryType: 'kmp-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'kmp-library-stability-check': {
    id: 'kmp-library-stability-check',
    name: 'KMP 稳定性检视',
    description: '检查 KMP 三方库鸿蒙化代码的稳定性，识别崩溃风险和异常处理缺陷',
    skillPath: 'KMPLibraryStabilityCheckSkill',
    libraryType: 'kmp-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'kmp-library-consistency-check': {
    id: 'kmp-library-consistency-check',
    name: 'KMP 一致性检视',
    description: '对比 KMP 鸿蒙化接口实现与 commonMain 声明的一致性，检测 expect/actual 匹配问题和潜在差异',
    skillPath: 'KMPLibraryConsistencyCheckSkill',
    libraryType: 'kmp-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'kmp-library-code-quality-check': {
    id: 'kmp-library-code-quality-check',
    name: 'KMP 编码质量检视',
    description: '对 KMP 三方库的鸿蒙化代码进行编码质量检视，分析代码规范、架构设计和可维护性',
    skillPath: 'KMPLibraryCodeQualityCheckSkill',
    libraryType: 'kmp-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'kmp-library-memory-leak-check': {
    id: 'kmp-library-memory-leak-check',
    name: 'KMP 内存泄露检视',
    description: '专项检查 KMP 三方库鸿蒙化代码的内存管理，识别潜在的内存泄露风险',
    skillPath: 'KMPLibraryMemoryLeakCheckSkill',
    libraryType: 'kmp-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'kmp-library-documentation-quality-check': {
    id: 'kmp-library-documentation-quality-check',
    name: 'KMP 文档质量检视',
    description: '检视 KMP 三方库鸿蒙化代码的文档质量，评估注释完整性和API文档规范',
    skillPath: 'KMPLibraryDocumentationQualityCheckSkill',
    libraryType: 'kmp-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  'kmp-library-test-coverage-check': {
    id: 'kmp-library-test-coverage-check',
    name: 'KMP 用例覆盖度检视',
    description: '评估 KMP 三方库鸿蒙化代码的测试覆盖率，验证关键功能的测试完整性',
    skillPath: 'KMPLibraryTestCoverageCheckSkill',
    libraryType: 'kmp-library',
    version: '1.0',
    author: 'CPPAgent',
  },

  // ─── JAVA 库鸿蒙化 SKILL ──────────────────────────────────────────────────
  'java-to-harmony-analyzer': {
    id: 'java-to-harmony-analyzer',
    name: 'JAVA 鸿蒙化分析',
    description: '分析 Java 三方库的鸿蒙化可行性，下载仓库源码，评估架构特征、依赖关系和平台耦合度，判定是否可以鸿蒙化',
    skillPath: 'JavaToHarmonyAnalyzer',
    libraryType: 'java-to-harmony',
    version: '1.0',
    author: 'CPPAgent',
  },
  'java-to-harmony-porting': {
    id: 'java-to-harmony-porting',
    name: 'JAVA 鸿蒙化移植',
    description: '基于分析报告创建鸿蒙工程，将 Java 代码逐模块移植为 ArkTS 实现',
    skillPath: 'JavaToHarmonyPorting',
    libraryType: 'java-to-harmony',
    version: '1.0',
    author: 'CPPAgent',
  },
  'java-to-harmony-comparison': {
    id: 'java-to-harmony-comparison',
    name: 'JAVA 鸿蒙化对比',
    description: '对比鸿蒙化移植结果与原始 Java 库的功能一致性，生成 0-100 评分报告',
    skillPath: 'JavaToHarmonyComparison',
    libraryType: 'java-to-harmony',
    version: '1.0',
    author: 'CPPAgent',
  },
  'java-to-harmony-fix': {
    id: 'java-to-harmony-fix',
    name: 'JAVA 鸿蒙化修复',
    description: '根据对比报告修复移植差异，逐条修复缺失 API 和行为不一致问题',
    skillPath: 'JavaToHarmonyFix',
    libraryType: 'java-to-harmony',
    version: '1.0',
    author: 'CPPAgent',
  },
  'java-to-harmony-library-interface': {
    id: 'java-to-harmony-library-interface',
    name: 'JAVA 鸿蒙化接口文档',
    description: '提取移植后鸿蒙工程的所有导出接口，生成结构化的接口规格说明文档',
    skillPath: 'JavaToHarmonyLibraryInterface',
    libraryType: 'java-to-harmony',
    version: '1.0',
    author: 'CPPAgent',
  },
  'java-to-harmony-demo-and-test': {
    id: 'java-to-harmony-demo-and-test',
    name: 'JAVA 鸿蒙化 Demo 与测试',
    description: '为鸿蒙化库创建 Demo 示例和 XTS 测试用例，执行测试并生成接口覆盖率与测试报告',
    skillPath: 'JavaToHarmonyDemoAndTest',
    libraryType: 'java-to-harmony',
    version: '1.0',
    author: 'CPPAgent',
  },
};

/**
 * SKILL 信息管理器类
 */
export class SkillInfoManager {
  constructor() {
    /** @type {Map<string, object>} SKILL元数据缓存 */
    this._cache = new Map();
    
    /** @type {string} Skills根目录 */
    this._skillsRoot = null;
  }

  /**
   * 初始化管理器
   * @param {string} skillsRoot - Skills目录根路径
   */
  initialize(skillsRoot) {
    this._skillsRoot = skillsRoot;
    logger.info('SkillInfoManager初始化完成', { skillsRoot });
  }

  /**
   * 获取代码检视相关的所有SKILL信息
   * @returns {object[]} SKILL信息数组
   */
  getCodeCheckSkills() {
    const codeCheckSkillIds = ['arkts-code-check', 'flutter-code-check', 'rn-code-check'];
    return codeCheckSkillIds.map(id => this.getSkillInfo(id));
  }

  /**
   * 获取Flutter仓库检视相关的所有SKILL信息
   * @returns {object[]} SKILL信息数组
   */
  getFlutterLibraryCheckSkills() {
    const flutterSkillIds = [
      'library-interface-analyzer',
      'flutter-library-stability-check',
      'flutter-library-consistency-check',
      'flutter-library-code-quality-check',
      'flutter-library-memory-leak-check',
      'flutter-library-documentation-quality-check',
      'flutter-library-test-coverage-check',
    ];
    return flutterSkillIds.map(id => this.getSkillInfo(id));
  }

  /**
   * 获取 ArkTS 仓库检视相关的所有SKILL信息
   * @returns {object[]} SKILL信息数组
   */
  getArktsLibraryCheckSkills() {
    const arktsSkillIds = [
      'arkts-library-interface-check',
      'arkts-library-stability-check',
      'arkts-library-code-quality-check',
      'arkts-library-memory-leak-check',
      'arkts-library-documentation-quality-check',
      'arkts-library-test-coverage-check',
    ];
    return arktsSkillIds.map(id => this.getSkillInfo(id));
  }

  /**
   * 获取 RN 仓库检视相关的所有SKILL信息
   * @returns {object[]} SKILL信息数组
   */
  getRNLibraryCheckSkills() {
    const rnSkillIds = [
      'rn-library-interface-check',
      'rn-library-stability-check',
      'rn-library-consistency-check',
      'rn-library-code-quality-check',
      'rn-library-memory-leak-check',
      'rn-library-documentation-quality-check',
      'rn-library-test-coverage-check',
    ];
    return rnSkillIds.map(id => this.getSkillInfo(id));
  }

  /**
   * 获取 KMP 仓库检视相关的所有SKILL信息
   * @returns {object[]} SKILL信息数组
   */
  getKMPLibraryCheckSkills() {
    const kmpSkillIds = [
      'kmp-library-interface-analyzer',
      'kmp-library-stability-check',
      'kmp-library-consistency-check',
      'kmp-library-code-quality-check',
      'kmp-library-memory-leak-check',
      'kmp-library-documentation-quality-check',
      'kmp-library-test-coverage-check',
    ];
    return kmpSkillIds.map(id => this.getSkillInfo(id));
  }

  /**
   * 获取三方库文档修改相关的SKILL信息
   * @returns {object[]} SKILL信息数组
   */
  getLibraryDocFixSkills() {
    const docFixSkillIds = ['library-doc-fix'];
    return docFixSkillIds.map(id => this.getSkillInfo(id));
  }

  /**
   * 获取JAVA库鸿蒙化相关的所有SKILL信息
   * @returns {object[]} SKILL信息数组
   */
  getJavaToHarmonySkills() {
    const javaToHarmonySkillIds = [
      'java-to-harmony-analyzer',
      'java-to-harmony-porting',
      'java-to-harmony-comparison',
      'java-to-harmony-fix',
      'java-to-harmony-library-interface',
      'java-to-harmony-demo-and-test',
    ];
    return javaToHarmonySkillIds.map(id => this.getSkillInfo(id));
  }

  /**
   * 根据三方库类型获取对应的SKILL信息
   * @param {string} libraryType - 三方库类型(arkts/flutter/rn)
   * @returns {object|null} SKILL信息对象
   */
  getSkillByLibraryType(libraryType) {
    const skillId = `${libraryType}-code-check`;
    return this.getSkillInfo(skillId);
  }

  /**
   * 获取单个SKILL的完整信息
   * @param {string} skillId - SKILL唯一标识符
   * @returns {object|null} SKILL信息对象
   */
  getSkillInfo(skillId) {
    if (this._cache.has(skillId)) {
      return this._cache.get(skillId);
    }

    const config = SKILL_CONFIGS[skillId];
    if (!config) {
      logger.warn('未知的SKILL ID', { skillId });
      return null;
    }

    const skillInfo = {
      ...config,
      skillMdPath: this._resolveSkillMdPath(config.skillPath),
      referencesDir: this._resolveReferencesDir(config.skillPath),
    };

    this._cache.set(skillId, skillInfo);
    return skillInfo;
  }

  /**
   * 获取SKILL.md文件的完整内容
   * @param {string} skillId - SKILL唯一标识符
   * @returns {Promise<string|null>} SKILL.md文件内容
   */
  async getSkillMarkdown(skillId) {
    const skillInfo = this.getSkillInfo(skillId);
    if (!skillInfo || !skillInfo.skillMdPath) {
      return null;
    }

    try {
      const content = await fs.readFile(skillInfo.skillMdPath, 'utf-8');
      logger.debug('成功读取SKILL.md', { skillId, path: skillInfo.skillMdPath });
      return content;
    } catch (err) {
      logger.error('读取SKILL.md失败', { skillId, error: err.message });
      return null;
    }
  }

  /**
   * 获取SKILL的references目录下的文件列表
   * @param {string} skillId - SKILL唯一标识符
   * @returns {Promise<string[]>} 文件名数组
   */
  async getSkillReferences(skillId) {
    const skillInfo = this.getSkillInfo(skillId);
    if (!skillInfo || !skillInfo.referencesDir) {
      return [];
    }

    try {
      const files = await fs.readdir(skillInfo.referencesDir);
      const mdFiles = files.filter(f => f.endsWith('.md'));
      logger.debug('获取references文件列表', { skillId, count: mdFiles.length });
      return mdFiles;
    } catch (err) {
      logger.warn('读取references目录失败', { skillId, error: err.message });
      return [];
    }
  }

  /**
   * 获取references目录下特定文件的内容
   * @param {string} skillId - SKILL唯一标识符
   * @param {string} fileName - 文件名
   * @returns {Promise<string|null>} 文件内容
   */
  async getSkillReferenceFile(skillId, fileName) {
    const skillInfo = this.getSkillInfo(skillId);
    if (!skillInfo || !skillInfo.referencesDir) {
      return null;
    }

    const filePath = path.join(skillInfo.referencesDir, fileName);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      logger.debug('成功读取reference文件', { skillId, fileName });
      return content;
    } catch (err) {
      logger.error('读取reference文件失败', { skillId, fileName, error: err.message });
      return null;
    }
  }

  /**
   * 解析SKILL.md文件路径
   * @private
   * @param {string} skillPath - SKILL目录名
   * @returns {string|null} 绝对路径
   */
  _resolveSkillMdPath(skillPath) {
    if (!this._skillsRoot) {
      return null;
    }
    return path.join(this._skillsRoot, skillPath, 'SKILL.md');
  }

  /**
   * 解析references目录路径
   * @private
   * @param {string} skillPath - SKILL目录名
   * @returns {string|null} 绝对路径
   */
  _resolveReferencesDir(skillPath) {
    if (!this._skillsRoot) {
      return null;
    }
    return path.join(this._skillsRoot, skillPath, 'references');
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this._cache.clear();
    logger.info('SKILL信息缓存已清除');
  }
}

// 导出单例实例
export const skillInfoManager = new SkillInfoManager();

// 导出配置供外部使用
export { SKILL_CONFIGS };