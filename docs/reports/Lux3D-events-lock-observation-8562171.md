# events-lock 观测入口同步

原全包 job_c4a5e01a 在8562171上479/480，唯一失败等待测试的accepted信号。根复核实际路径：GET /version调用WorkService.snapshotWithListing，再进入repo.snapshotWithListing；测试仍spy repo.snapshot，因而无法发出entered信号。失败日志只到init/listen，没有accepted，与源码一致。

本次只把原spy和绑定原方法同步到snapshotWithListing。不改真实HTTP请求、gate、preClose、排空、实例锁、关闭后的SERVICE_CLOSING、事件落盘、重启和嵌套repo断言。默认5秒、并发和重试不变，产品运行逻辑未改。

不先单跑该文件后再重跑全包。下一次统一server整包运行将同时验证该观测点和其它内部调用方；旧480例失败与runner文件计数解析缺陷保留原件，不据本次静态修改改写为通过。
