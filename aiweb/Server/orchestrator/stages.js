/**
 * 状态常量定义
 *
 * 状态机（两种路径）：
 * 
 *   路径一（已知依赖 DependOK）：
 *   pending → analyzing → analysis_complete → compiling → compile_complete → porting → porting_complete → testing → test_complete
 *
 *   路径二（未知依赖 DependError）：
 *   pending → analyzing → analysis_complete → (等待依赖处理)
 *                                                                      ↓
 *                                                                    failed
 */

export const STAGE = Object.freeze({
    PENDING: 'pending',
    ANALYZING: 'analyzing',
    ANALYSIS_COMPLETE: 'analysis_complete',
    COMPILING: 'compiling',
    COMPILE_COMPLETE: 'compile_complete',
    PORTING: 'porting',
    PORTING_COMPLETE: 'porting_complete',
    TESTING: 'testing',
    TEST_COMPLETE: 'test_complete',
    // 代码检视阶段
    CODECHECK_PENDING: 'codecheck_pending',
    CODECHECK_ANALYZING: 'codecheck_analyzing',
    CODECHECK_COMPLETE: 'codecheck_complete',
    // Issue 分析阶段（Issue 报告 / 根因 / 优先级 / 解决方案 / 关联检索）
    ISSUEANALYSIS_PENDING: 'issueanalysis_pending',
    ISSUEANALYSIS_FETCHING: 'issueanalysis_fetching',
    ISSUEANALYSIS_ANALYZING: 'issueanalysis_analyzing',
    ISSUEANALYSIS_COMPLETE: 'issueanalysis_complete',
    // Flutter 仓库检视阶段（7 个 SKILL）
    FLUTTERLIBRARYCHECK_PENDING: 'flutterlibrarycheck_pending',
    FLUTTERLIBRARYCHECK_INTERFACE_ANALYZING: 'flutterlibrarycheck_interface_analyzing',
    FLUTTERLIBRARYCHECK_PARALLEL_ANALYZING: 'flutterlibrarycheck_parallel_analyzing',  // 6 个检视 SKILL 并发执行中
    FLUTTERLIBRARYCHECK_STABILITY_ANALYZING: 'flutterlibrarycheck_stability_analyzing',
    FLUTTERLIBRARYCHECK_CONSISTENCY_ANALYZING: 'flutterlibrarycheck_consistency_analyzing',
    FLUTTERLIBRARYCHECK_CODE_QUALITY_ANALYZING: 'flutterlibrarycheck_code_quality_analyzing',
    FLUTTERLIBRARYCHECK_MEMORY_LEAK_ANALYZING: 'flutterlibrarycheck_memory_leak_analyzing',
    FLUTTERLIBRARYCHECK_DOCUMENTATION_ANALYZING: 'flutterlibrarycheck_documentation_analyzing',
    FLUTTERLIBRARYCHECK_TEST_COVERAGE_ANALYZING: 'flutterlibrarycheck_test_coverage_analyzing',
    FLUTTERLIBRARYCHECK_COMPLETE: 'flutterlibrarycheck_complete',
    // ArkTS 仓库检视阶段（6 个 SKILL，无一致性维度）
    ARKTSLIBRARYCHECK_PENDING: 'arktslibrarycheck_pending',
    ARKTSLIBRARYCHECK_INTERFACE_ANALYZING: 'arktslibrarycheck_interface_analyzing',
    ARKTSLIBRARYCHECK_PARALLEL_ANALYZING: 'arktslibrarycheck_parallel_analyzing',  // 5 个检视 SKILL 并发执行中
    ARKTSLIBRARYCHECK_STABILITY_ANALYZING: 'arktslibrarycheck_stability_analyzing',
    ARKTSLIBRARYCHECK_CODE_QUALITY_ANALYZING: 'arktslibrarycheck_code_quality_analyzing',
    ARKTSLIBRARYCHECK_MEMORY_LEAK_ANALYZING: 'arktslibrarycheck_memory_leak_analyzing',
    ARKTSLIBRARYCHECK_DOCUMENTATION_ANALYZING: 'arktslibrarycheck_documentation_analyzing',
    ARKTSLIBRARYCHECK_TEST_COVERAGE_ANALYZING: 'arktslibrarycheck_test_coverage_analyzing',
    ARKTSLIBRARYCHECK_COMPLETE: 'arktslibrarycheck_complete',
    // RN 仓库检视阶段（7 个 SKILL，含一致性维度）
    RNLIBRARYCHECK_PENDING: 'rnlibrarycheck_pending',
    RNLIBRARYCHECK_INTERFACE_ANALYZING: 'rnlibrarycheck_interface_analyzing',
    RNLIBRARYCHECK_PARALLEL_ANALYZING: 'rnlibrarycheck_parallel_analyzing',  // 6 个检视 SKILL 并发执行中
    RNLIBRARYCHECK_STABILITY_ANALYZING: 'rnlibrarycheck_stability_analyzing',
    RNLIBRARYCHECK_CONSISTENCY_ANALYZING: 'rnlibrarycheck_consistency_analyzing',
    RNLIBRARYCHECK_CODE_QUALITY_ANALYZING: 'rnlibrarycheck_code_quality_analyzing',
    RNLIBRARYCHECK_MEMORY_LEAK_ANALYZING: 'rnlibrarycheck_memory_leak_analyzing',
    RNLIBRARYCHECK_DOCUMENTATION_ANALYZING: 'rnlibrarycheck_documentation_analyzing',
    RNLIBRARYCHECK_TEST_COVERAGE_ANALYZING: 'rnlibrarycheck_test_coverage_analyzing',
    RNLIBRARYCHECK_COMPLETE: 'rnlibrarycheck_complete',
    // KMP 仓库检视阶段（7 个 SKILL，含一致性维度）
    KMPLIBRARYCHECK_PENDING: 'kmplibrarycheck_pending',
    KMPLIBRARYCHECK_INTERFACE_ANALYZING: 'kmplibrarycheck_interface_analyzing',
    KMPLIBRARYCHECK_PARALLEL_ANALYZING: 'kmplibrarycheck_parallel_analyzing',  // 6 个检视 SKILL 并发执行中
    KMPLIBRARYCHECK_STABILITY_ANALYZING: 'kmplibrarycheck_stability_analyzing',
    KMPLIBRARYCHECK_CONSISTENCY_ANALYZING: 'kmplibrarycheck_consistency_analyzing',
    KMPLIBRARYCHECK_CODE_QUALITY_ANALYZING: 'kmplibrarycheck_code_quality_analyzing',
    KMPLIBRARYCHECK_MEMORY_LEAK_ANALYZING: 'kmplibrarycheck_memory_leak_analyzing',
    KMPLIBRARYCHECK_DOCUMENTATION_ANALYZING: 'kmplibrarycheck_documentation_analyzing',
    KMPLIBRARYCHECK_TEST_COVERAGE_ANALYZING: 'kmplibrarycheck_test_coverage_analyzing',
    KMPLIBRARYCHECK_COMPLETE: 'kmplibrarycheck_complete',
    // C++ 仓库分析阶段
    CPPANALYSIS_PENDING: 'cppanalysis_pending',
    CPPANALYSIS_ANALYZING: 'cppanalysis_analyzing',
    CPPANALYSIS_COMPLETE: 'cppanalysis_complete',
    // 三方库文档修改阶段
    LIBRARYDOCFIX_PENDING: 'librarydocfix_pending',
    LIBRARYDOCFIX_ANALYZING: 'librarydocfix_analyzing',
    LIBRARYDOCFIX_COMPLETE: 'librarydocfix_complete',
    // JAVA 库鸿蒙化阶段（6 个 SKILL 依次执行）
    JAVATOHARMONY_PENDING: 'javatoharmony_pending',
    JAVATOHARMONY_ANALYZING: 'javatoharmony_analyzing',
    JAVATOHARMONY_PORTING: 'javatoharmony_porting',
    JAVATOHARMONY_COMPARING: 'javatoharmony_comparing',
    JAVATOHARMONY_FIXING: 'javatoharmony_fixing',
    JAVATOHARMONY_INTERFACE: 'javatoharmony_interface',
    JAVATOHARMONY_DEMO_TEST: 'javatoharmony_demo_test',
    JAVATOHARMONY_COMPLETE: 'javatoharmony_complete',
    // TPC 三方库接口覆盖率分析与 XTS 测试生成阶段（6 个 SKILL 依次执行）
    TPCCOVERAGE_PENDING: 'tpccoverage_pending',
    TPCCOVERAGE_INTERFACE_SPEC: 'tpccoverage_interface_spec',
    TPCCOVERAGE_DEMO_COVERAGE: 'tpccoverage_demo_coverage',
    TPCCOVERAGE_XTS_COVERAGE: 'tpccoverage_xts_coverage',
    TPCCOVERAGE_DEMO_SUPPLEMENT: 'tpccoverage_demo_supplement',
    TPCCOVERAGE_XTS_DOC: 'tpccoverage_xts_doc',
    TPCCOVERAGE_XTS_CODE: 'tpccoverage_xts_code',
    TPCCOVERAGE_XTS_EXECUTION: 'tpccoverage_xts_execution',
    TPCCOVERAGE_COMPLETE: 'tpccoverage_complete',
    // 终态
    FAILED: 'failed',
    CANCELLED: 'cancelled',
});

export const TERMINAL_STAGES = new Set([
    'test_complete', 'codecheck_complete', 'flutterlibrarycheck_complete',
    'arktslibrarycheck_complete', 'rnlibrarycheck_complete', 'kmplibrarycheck_complete',
    'cppanalysis_complete',
    'librarydocfix_complete',
    'javatoharmony_complete',
    'issueanalysis_complete',
    'tpccoverage_complete',
    'failed', 'cancelled',
]);
