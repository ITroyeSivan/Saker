// dsh-method-stack — web client.
//
// v6 第 4.1 节：设置页的方法选择与聊天工具栏的模块筛选入口退出运行。
// 测试内容选择并入 Saker 的「测试设置」（redteam-results 的 test.content），
// 方法正文由模型用 saker_method 按需读取。这里不再注册任何宿主插槽；
// 保留本模块只为满足插件声明的 client 装载契约（宿主仍会加载并调用 apply）。
window.__ModuleLoader__.load({ id: '@dsh-external/dsh-method-stack', factory: (require) => {
var module = { exports: {} };

function apply(ctx) {
  // 不注册任何插槽：第二个导航与并行的「模块」概念都已删除。
  void ctx;
}

module.exports = {
  name: 'dsh-method-stack-client',
  inject: ['slots', 'connection', 'remote', 'sessions'],
  apply: apply,
};
return module.exports; } });
