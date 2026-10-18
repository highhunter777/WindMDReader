/**
 * 离线词典(英汉精选 + 汉英反查)。
 *
 * 定位:阅读器划词翻译的**第一响应** —— 本地、零延迟、零网络请求。
 * 不为「全量词典」买单(ECDICT 全量 30MB+),而是精选高频词 +
 * 技术术语 + 常用短语,覆盖开发/知识管理场景的绝大多数划词需求;
 * 未收录的词由 UI 给出近似建议,并可选用在线翻译兜底。
 *
 * 数据格式(紧凑,一行一条):
 *   `词条|释义1;释义2`
 * 释义可带词性前缀(`n. ` / `v. ` …),反查时自动剥离。
 */

interface RawEntry {
  word: string;
  defs: string[];
}

const RAW = `
# --- 基础高频:代词/量词/连接 ---
i|pron. 我
you|pron. 你;你们
he|pron. 他
she|pron. 她
it|pron. 它
we|pron. 我们
they|pron. 他们;她们;它们
me|pron. 我(宾格)
him|pron. 他(宾格)
her|pron. 她的;她(宾格)
us|pron. 我们(宾格)
them|pron. 他们(宾格)
my|pron. 我的
your|pron. 你的;你们的
his|pron. 他的
its|pron. 它的
our|pron. 我们的
their|pron. 他们的
this|pron. 这;这个
that|pron. 那;那个
these|pron. 这些
those|pron. 那些
what|pron. 什么
which|pron. 哪一个
who|pron. 谁
whom|pron. 谁(宾格)
whose|pron. 谁的
when|conj. 当…时;什么时候
where|conj. 在哪里
why|adv. 为什么
how|adv. 怎样;多么
all|adj. 全部的;adv. 全部
both|adj. 两者的;pron. 两者都
each|adj. 每个;pron. 各自
every|adj. 每一个
some|adj. 一些;pron. 一些
any|adj. 任何;pron. 任何一个
none|pron. 没有任何
few|adj. 很少的;pron. 很少
little|adj. 少的;小的
many|adj. 许多
much|adj. 很多;adv. 非常
more|adj. 更多的;adv. 更
most|adj. 最多的;adv. 最
other|adj. 其他的;pron. 另一个
another|adj. 另一的;pron. 另一个
same|adj. 相同的
such|adj. 这样的;adv. 如此
own|adj. 自己的;v. 拥有
# --- 基础高频:动词 ---
be|v. 是;存在
am|v. 是(第一人称)
is|v. 是(第三人称单数)
are|v. 是(复数/第二人称)
was|v. 是(过去时,单数)
were|v. 是(过去时,复数)
been|v. be 的过去分词
being|v. be 的现在分词;n. 存在;生物
have|v. 有;已经
has|v. 有(第三人称单数)
had|v. 有(过去时)
do|v. 做;助动词
does|v. 做(第三人称单数)
did|v. 做(过去时)
done|v. 做(过去分词)
will|v. 将要;n. 意志
would|v. will 的过去时;会
shall|v. 将要;应该
should|v. 应该;可能
can|v. 能够;可以
could|v. can 的过去时
may|v. 可能;可以
might|v. 可能(may 的过去时)
must|v. 必须;一定
need|v. 需要;n. 需要
dare|v. 敢;胆敢
used|v. 过去常常;用过的
go|v. 去;走;进行
goes|v. 去(第三人称单数)
went|v. 去(过去时)
gone|v. go 的过去分词
come|v. 来;来到
came|v. come 的过去时
get|v. 得到;变得;到达
got|v. get 的过去时
gotten|v. get 的过去分词(美)
make|v. 做;制造;使得
made|v. make 的过去式/过去分词
take|v. 拿;花费;采取
took|v. take 的过去时
taken|v. take 的过去分词
give|v. 给;给予
gave|v. give 的过去时
given|v. give 的过去分词;conj. 考虑到
find|v. 找到;发现
found|v. find 的过去式/过去分词
think|v. 想;认为;思考
thought|v. think 的过去式/过去分词;n. 想法
know|v. 知道;认识
knew|v. know 的过去时
known|v. know 的过去分词;adj. 已知的
see|v. 看见;理解
saw|v. see 的过去时
seen|v. see 的过去分词
want|v. 想要;n. 缺乏
use|v. 使用;n. 用途
work|v. 工作;n. 工作
worked|v. work 的过去式/过去分词
call|v. 打电话;称呼;调用
called|v. call 的过去式/过去分词;adj. 所谓的
try|v. 尝试;n. 尝试
ask|v. 问;要求
put|v. 放;放置
mean|v. 意味着;意思是
meant|v. mean 的过去式/过去分词
keep|v. 保持;保留
let|v. 让;允许
begin|v. 开始
began|v. begin 的过去时
begun|v. begin 的过去分词
start|v. 开始;启动
seem|v. 似乎;好像
help|v. 帮助;n. 帮助
show|v. 展示;表明
hear|v. 听见;听说
run|v. 跑;运行;经营
ran|v. run 的过去时
move|v. 移动;搬家
live|v. 居住;生活;adj. 现场的
believe|v. 相信;认为
bring|v. 带来
happen|v. 发生
write|v. 写
wrote|v. write 的过去时
written|v. write 的过去分词
sit|v. 坐
stand|v. 站;忍受
lose|v. 失去;输
lost|v. lose 的过去式/过去分词;adj. 迷失的
pay|v. 支付;n. 工资
meet|v. 见面;满足
include|v. 包括
continue|v. 继续
set|v. 设置;n. 集合
learn|v. 学习;得知
change|v. 改变;n. 变化;零钱
lead|v. 领导;导致
understand|v. 理解
watch|v. 观看;n. 手表
follow|v. 跟随;遵循
stop|v. 停止;n. 车站
create|v. 创造
speak|v. 说话
read|v. 读;阅读
spend|v. 花费
grow|v. 增长;种植
open|v. 打开;adj. 开放的
walk|v. 走;n. 步行
win|v. 赢;获胜
offer|v. 提供;n. 报价
remember|v. 记得
love|v. 爱;喜欢
consider|v. 考虑;认为
appear|v. 出现;显得
buy|v. 买
wait|v. 等待
serve|v. 服务;供应
die|v. 死
send|v. 发送
build|v. 建造;构建
stay|v. 停留;保持
fall|v. 落下;n. 秋天
cut|v. 切;削减
reach|v. 到达;达到
remain|v. 保持;仍然是
raise|v. 提高;筹集
sell|v. 卖
require|v. 需要;要求
report|v. 报告;n. 报告
decide|v. 决定
pull|v. 拉
return|v. 返回;归还;n. 回报
explain|v. 解释
hope|v. 希望;n. 希望
develop|v. 开发;发展
carry|v. 携带;承担
break|v. 打破;n. 休息
receive|v. 收到
agree|v. 同意
support|v. 支持;n. 支持
hit|v. 打;击中
produce|v. 生产;产生
eat|v. 吃
cover|v. 覆盖;n. 封面
catch|v. 抓住;赶上
choose|v. 选择
chose|v. choose 的过去时
chosen|v. choose 的过去分词
# --- 基础高频:名词 ---
time|n. 时间;次
year|n. 年
people|n. 人;人们
way|n. 方法;路
day|n. 天;白天
man|n. 男人;人
woman|n. 女人
child|n. 孩子
children|n. 孩子们(复数)
world|n. 世界
life|n. 生活;生命
hand|n. 手
part|n. 部分;角色
eye|n. 眼睛
place|n. 地方;放置
case|n. 情况;案例;盒子
week|n. 周
company|n. 公司;陪伴
system|n. 系统
program|n. 程序;节目;计划
question|n. 问题;v. 质疑
government|n. 政府
number|n. 数字;号码
night|n. 夜晚
point|n. 点;观点;分数
home|n. 家;adv. 在家
water|n. 水;v. 浇水
room|n. 房间;空间
mother|n. 母亲
area|n. 区域;面积
money|n. 钱
story|n. 故事;楼层
fact|n. 事实
month|n. 月
book|n. 书;v. 预订
word|n. 单词;话语;承诺
business|n. 商业;生意;事务
issue|n. 问题;议题;v. 发行
side|n. 边;侧;方面
kind|n. 种类;adj. 善良的
head|n. 头;领导;v. 率领
house|n. 房子
friend|n. 朋友
father|n. 父亲
power|n. 力量;权力;电力
hour|n. 小时
game|n. 游戏;比赛
line|n. 线;行;队列
end|n. 结束;v. 结束
member|n. 成员
law|n. 法律;定律
car|n. 汽车
city|n. 城市
name|n. 名字;v. 命名
team|n. 团队
minute|n. 分钟;adj. 微小的
idea|n. 想法;主意
body|n. 身体;主体;正文
information|n. 信息
back|n. 背部;adv. 回来;adj. 后面的
face|n. 脸;面对;v. 面对
level|n. 水平;等级;adj. 水平的
office|n. 办公室;职务
door|n. 门
health|n. 健康
person|n. 人
art|n. 艺术;人工
history|n. 历史
result|n. 结果;v. 导致
morning|n. 早晨
reason|n. 原因;理性
research|n. 研究;v. 研究
girl|n. 女孩
guy|n. 家伙;人
moment|n. 时刻
air|n. 空气;空中
teacher|n. 教师
force|n. 力量;武力;v. 强迫
education|n. 教育
foot|n. 脚;英尺
boy|n. 男孩
age|n. 年龄;时代
policy|n. 政策;方针
process|n. 过程;v. 处理
music|n. 音乐
market|n. 市场
sense|n. 感觉;意义;v. 感知
plan|n. 计划;v. 计划
college|n. 大学;学院
interest|n. 兴趣;利息;利益
death|n. 死亡
experience|n. 经验;经历;v. 经历
effect|n. 效果;影响;v. 实现
class|n. 班级;阶级;类
control|n. 控制;v. 控制
care|n. 关心;照顾;v. 在意
field|n. 领域;田野;字段
role|n. 角色;作用
effort|n. 努力
rule|n. 规则;v. 统治
note|n. 笔记;注释;v. 注意
meeting|n. 会议
food|n. 食物
paper|n. 纸;论文
light|n. 光;adj. 轻的;亮的
news|n. 新闻;消息
study|n. 学习;研究;v. 学习
energy|n. 能量;精力
science|n. 科学
# --- 基础高频:形容词/副词 ---
good|adj. 好的
bad|adj. 坏的
big|adj. 大的
small|adj. 小的
large|adj. 大的;大规模的
long|adj. 长的;adv. 长期地
short|adj. 短的;矮的
tall|adj. 高的
high|adj. 高的;adv. 高地
low|adj. 低的
old|adj. 老的;旧的
young|adj. 年轻的
new|adj. 新的
early|adj. 早的;adv. 早
late|adj. 晚的;迟的;adv. 迟
fast|adj. 快的;adv. 快地
slow|adj. 慢的
quick|adj. 快的
hot|adj. 热的
cold|adj. 冷的;感冒
warm|adj. 温暖的
cool|adj. 凉的;酷的
easy|adj. 容易的
hard|adj. 困难的;硬的;adv. 努力地
difficult|adj. 困难的
simple|adj. 简单的
clear|adj. 清楚的;v. 清除
strong|adj. 强壮的;强烈的
weak|adj. 弱的
happy|adj. 快乐的
sad|adj. 悲伤的
beautiful|adj. 美丽的
ugly|adj. 丑的
rich|adj. 富有的;丰富的
poor|adj. 贫穷的;差的
full|adj. 满的;完整的
empty|adj. 空的
right|adj. 正确的;右边的;n. 权利
wrong|adj. 错误的
true|adj. 真实的;正确的
false|adj. 错误的;假的
real|adj. 真实的;adj. 真的
sure|adj. 确信的;一定的
ready|adj. 准备好的
free|adj. 自由的;免费的;空闲的
busy|adj. 忙的
important|adj. 重要的
different|adj. 不同的
similar|adj. 相似的
common|adj. 常见的;共同的;n. 公共
usual|adj. 通常的
special|adj. 特别的
normal|adj. 正常的;n. 常态
strange|adj. 奇怪的;陌生的
interesting|adj. 有趣的
boring|adj. 无聊的
useful|adj. 有用的
helpful|adj. 有帮助的
careful|adj. 仔细的;小心的
lucky|adj. 幸运的
possible|adj. 可能的
impossible|adj. 不可能的
able|adj. 能够的
available|adj. 可用的;有空的
public|adj. 公共的;n. 公众
private|adj. 私有的;私人的
main|adj. 主要的
general|adj. 一般的;总的;n. 将军
final|adj. 最终的;n. 决赛
single|adj. 单一的;单身的
whole|adj. 整个的
local|adj. 本地的;当地的
global|adj. 全球的;全局的
social|adj. 社会的;社交的
natural|adj. 自然的;天然的
human|adj. 人类的;n. 人
close|v. 关闭;adj. 近的
dead|adj. 死亡的;adv. 完全地
alone|adj. 单独的;adv. 独自
alive|adj. 活着的
safe|adj. 安全的;n. 保险箱
dangerous|adj. 危险的
quiet|adj. 安静的
loud|adj. 大声的
deep|adj. 深的;adv. 深深地
heavy|adj. 重的;大量的
soft|adj. 柔软的
clean|adj. 干净的;v. 打扫
dirty|adj. 脏的
fresh|adj. 新鲜的;新的
quickly|adv. 快速地
slowly|adv. 缓慢地
really|adv. 真正地;非常
very|adv. 非常
too|adv. 太;也
also|adv. 也
just|adv. 只是;刚才;adj. 公正的
only|adv. 只;仅仅;adj. 唯一的
even|adv. 甚至;adj. 偶数的
still|adv. 仍然;adj. 静止的
already|adv. 已经
yet|adv. 还;已经
again|adv. 再一次
soon|adv. 很快
often|adv. 经常
sometimes|adv. 有时
always|adv. 总是
never|adv. 从不
usually|adv. 通常
here|adv. 这里
there|adv. 那里
now|adv. 现在;n. 现在
then|adv. 然后;那时
today|adv. 今天;n. 今天
tomorrow|adv. 明天;n. 明天
yesterday|adv. 昨天;n. 昨天
ago|adv. 以前
later|adv. 后来;adj. 以后的
before|prep. 在…之前;conj. 在…以前
after|prep. 在…之后;conj. 在…以后
above|prep. 在…上方;adv. 在上面
below|prep. 在…下方
under|prep. 在…下面
over|prep. 在…上方;超过
between|prep. 在…之间
among|prep. 在…之中(三者以上)
through|prep. 穿过;通过
across|prep. 横过;adv. 穿过
against|prep. 反对;靠着
during|prep. 在…期间
without|prep. 没有
within|prep. 在…之内
along|prep. 沿着
behind|prep. 在…后面
beyond|prep. 超过;adv. 在远处
near|prep. 靠近;adj. 近的
around|prep. 围绕;adv. 周围
about|prep. 关于;大约;adv. 大约
with|prep. 和…一起;用
for|prep. 为了;因为
from|prep. 来自
of|prep. …的
at|prep. 在(地点/时间)
in|prep. 在…里
on|prep. 在…上
by|prep. 通过;被;乘
to|prep. 到;向
into|prep. 进入
onto|prep. 到…上面
off|prep. 离开;adv. 关掉
up|adv. 向上;prep. 向上
down|adv. 向下;prep. 沿着
out|adv. 出去;adj. 外面的
and|conj. 和;而且
or|conj. 或者;否则
but|conj. 但是
so|conj. 所以;adv. 如此
because|conj. 因为
if|conj. 如果;是否
although|conj. 尽管
though|conj. 虽然;adv. 不过
while|conj. 当…时;虽然
since|conj. 自从;因为
until|conj. 直到…为止
unless|conj. 除非
whether|conj. 是否
than|conj. 比
as|conj. 作为;当…时;adv. 同样地
like|prep. 像;v. 喜欢
unlike|prep. 不像
# --- 技术/编程 ---
algorithm|n. 算法
api|n. 应用程序接口(API)
application|n. 应用;应用程序;申请
argument|n. 参数;论点;争论
array|n. 数组;一大批
assign|v. 赋值;分配
attribute|n. 属性;v. 归于
backend|n. 后端
binary|n. 二进制;adj. 二进制的
bind|v. 绑定
bit|n. 比特(位);一点
block|n. 块;阻塞;v. 阻塞
boolean|n. 布尔值;adj. 布尔的
branch|n. 分支;支路;v. 分支
breakpoint|n. 断点
bug|n. 缺陷;错误
byte|n. 字节
cache|n. 缓存;v. 缓存
callback|n. 回调(函数)
character|n. 字符;角色;性格
client|n. 客户端;客户
cli|n. 命令行界面(CLI)
cloud|n. 云;云端
cluster|n. 集群;簇
code|n. 代码;v. 编码
command|n. 命令;v. 指挥
comment|n. 注释;评论;v. 评论
compile|v. 编译
compiler|n. 编译器
component|n. 组件;部件
compute|v. 计算
computer|n. 计算机
concurrency|n. 并发
condition|n. 条件;状况
config|n. 配置
configuration|n. 配置
connect|v. 连接
constant|n. 常量;adj. 恒定的
container|n. 容器
context|n. 上下文;语境
cookie|n. Cookie(小型文本文件)
crash|n. 崩溃;v. 崩溃
cursor|n. 光标;游标
dashboard|n. 仪表盘
data|n. 数据
database|n. 数据库
debug|v. 调试;n. 调试
declare|v. 声明
default|n. 默认值;adj. 默认的
define|v. 定义
delete|v. 删除
deploy|v. 部署
deprecated|adj. 已弃用的
design|n. 设计;v. 设计
desktop|n. 桌面;adj. 桌面的
developer|n. 开发者
device|n. 设备
diagram|n. 图表
directory|n. 目录
distributed|adj. 分布式的
document|n. 文档;v. 记录
domain|n. 域;领域
download|v. 下载;n. 下载
edit|v. 编辑
editor|n. 编辑器
element|n. 元素;元件
embed|v. 嵌入
engine|n. 引擎
environment|n. 环境
error|n. 错误
event|n. 事件
exception|n. 异常
execute|v. 执行
exit|v. 退出;n. 出口
export|v. 导出;n. 出口
expression|n. 表达式
extension|n. 扩展;扩展名
feature|n. 特性;功能
file|n. 文件
filter|v. 过滤;n. 过滤器
firewall|n. 防火墙
flag|n. 标志;旗
folder|n. 文件夹
font|n. 字体
framework|n. 框架
function|n. 函数;功能
gateway|n. 网关
generate|v. 生成
gpu|n. 图形处理器(GPU)
graph|n. 图;图形
gui|n. 图形用户界面(GUI)
handle|v. 处理;n. 句柄
hardware|n. 硬件
hash|n. 哈希;散列;v. 散列
header|n. 头部;页眉;头文件
heap|n. 堆
host|n. 主机;v. 主办
http|n. 超文本传输协议(HTTP)
icon|n. 图标
identifier|n. 标识符
image|n. 图像;镜像
implement|v. 实现;执行
import|v. 导入;n. 进口
index|n. 索引;指数
initialize|v. 初始化
input|n. 输入;v. 输入
insert|v. 插入
install|v. 安装
instance|n. 实例
integer|n. 整数
interface|n. 接口;界面
internal|adj. 内部的
internet|n. 互联网
interpreter|n. 解释器
iterate|v. 迭代
kernel|n. 内核
key|n. 键;密钥;adj. 关键的
keyboard|n. 键盘
keyword|n. 关键词
latency|n. 延迟
launch|v. 启动;发起;n. 发布
layer|n. 层
layout|n. 布局
library|n. 库;图书馆
link|n. 链接;v. 连接
list|n. 列表;v. 列出
load|v. 加载;n. 负载
lock|v. 锁;n. 锁
log|n. 日志;v. 记录
logic|n. 逻辑
loop|n. 循环;v. 循环
machine|n. 机器
memory|n. 内存;记忆
merge|v. 合并
message|n. 消息;v. 发消息
method|n. 方法
metric|n. 指标;度量
middleware|n. 中间件
migrate|v. 迁移
module|n. 模块
monitor|n. 监视器;v. 监控
mouse|n. 鼠标
network|n. 网络
node|n. 节点
null|n. 空值;adj. 无效的
object|n. 对象;物体
offline|adj. 离线的;adv. 离线
online|adj. 在线的;adv. 在线
operate|v. 操作;运行
operator|n. 运算符;操作员
optimize|v. 优化
option|n. 选项
output|n. 输出;v. 输出
overflow|n. 溢出;v. 溢出
override|v. 重写;覆盖
package|n. 包;v. 打包
page|n. 页面;页
parameter|n. 参数
parse|v. 解析
parser|n. 解析器
password|n. 密码
patch|n. 补丁;v. 修补
path|n. 路径
pattern|n. 模式;图案
performance|n. 性能;表现
permission|n. 权限
pipeline|n. 流水线;管道
pixel|n. 像素
platform|n. 平台
plugin|n. 插件
pointer|n. 指针
poll|v. 轮询;n. 民意调查
port|n. 端口;港口
preview|n. 预览;v. 预览
print|v. 打印
product|n. 产品
profile|n. 配置;轮廓
progress|n. 进度
project|n. 项目
promise|n. Promise(承诺);v. 承诺
protocol|n. 协议
prototype|n. 原型
proxy|n. 代理;v. 代理
query|n. 查询;v. 查询
queue|n. 队列;v. 排队
render|v. 渲染
repository|n. 仓库;存储库
request|n. 请求;v. 请求
resolve|v. 解析;解决
resource|n. 资源
response|n. 响应;回答
restore|v. 恢复;还原
reuse|v. 重用
review|v. 审查;评论;n. 评审
route|n. 路由;v. 路由
runtime|n. 运行时
sandbox|n. 沙箱
schedule|v. 调度;安排;n. 日程
schema|n. 模式;架构
scope|n. 作用域;范围
screen|n. 屏幕
script|n. 脚本
scroll|v. 滚动;n. 滚动
search|v. 搜索;n. 搜索
security|n. 安全
select|v. 选择
semantic|adj. 语义的
server|n. 服务器
service|n. 服务
session|n. 会话
setting|n. 设置
shell|n. 外壳;命令行解释器
signal|n. 信号
snapshot|n. 快照
socket|n. 套接字
software|n. 软件
source|n. 源;来源
space|n. 空间;空格
stack|n. 栈;堆叠
state|n. 状态;州
statement|n. 语句;声明
static|adj. 静态的
status|n. 状态
storage|n. 存储
stream|n. 流;v. 流式传输
string|n. 字符串
structure|n. 结构
style|n. 风格;样式
submit|v. 提交
subscribe|v. 订阅
substring|n. 子串
syntax|n. 语法
table|n. 表;表格
tag|n. 标签
target|n. 目标;靶子
task|n. 任务
template|n. 模板
terminal|n. 终端
test|n. 测试;v. 测试
text|n. 文本;正文
theme|n. 主题
thread|n. 线程
throw|v. 抛出;扔
timeout|n. 超时
timestamp|n. 时间戳
token|n. 令牌;标记
tool|n. 工具
toolbar|n. 工具栏
trace|v. 追踪;n. 痕迹
trigger|v. 触发;n. 触发器
type|n. 类型;v. 打字
update|v. 更新;n. 更新
upload|v. 上传
url|n. 统一资源定位符(URL)
user|n. 用户
validate|v. 验证
value|n. 值
variable|n. 变量
vector|n. 向量;矢量
vendor|n. 供应商
version|n. 版本
view|n. 视图;v. 查看
viewport|n. 视口
virtual|adj. 虚拟的
volume|n. 卷;音量;体积
web|n. 网络;Web
widget|n. 小部件
window|n. 窗口
wireframe|n. 线框图
workflow|n. 工作流
wrapper|n. 包装器
# --- 技术:架构/工程实践 ---
abstract|adj. 抽象的;n. 摘要
access|v. 访问;n. 访问
account|n. 账户;账号
accurate|adj. 精确的
adapt|v. 适应;改编
address|n. 地址;v. 处理
advance|v. 推进;n. 前进
aggregate|v. 聚合;adj. 聚合的
alias|n. 别名
allocate|v. 分配
alternative|n. 替代方案;adj. 替代的
analyze|v. 分析
annotation|n. 注解
anonymous|adj. 匿名的
append|v. 追加
approve|v. 批准
arbitrary|adj. 任意的
archive|n. 归档;档案
artifact|n. 产物;工件
assemble|v. 组装
assert|v. 断言
asset|n. 资产;资源
associate|v. 关联;adj. 副的
assume|v. 假设
asynchronous|adj. 异步的
atomic|adj. 原子的;不可分割的
attach|v. 附加;附上
attempt|v. 尝试;n. 尝试
audit|n. 审计;v. 审计
authenticate|v. 认证
authorize|v. 授权
automate|v. 自动化
autonomous|adj. 自主的
availability|n. 可用性
backup|n. 备份;v. 备份
baseline|n. 基线;基准
batch|n. 批处理;一批
benchmark|n. 基准测试
bottleneck|n. 瓶颈
boundary|n. 边界
browse|v. 浏览
buffer|n. 缓冲区;v. 缓冲
candidate|n. 候选
capability|n. 能力
capacity|n. 容量;能力
capture|v. 捕获
cascade|v. 级联;n. 级联
catalog|n. 目录
certificate|n. 证书
challenge|n. 挑战;v. 挑战
channel|n. 通道;频道
chart|n. 图表
checklist|n. 检查清单
checksum|n. 校验和
chunk|n. 块;分块
clarify|v. 澄清
cleanup|n. 清理
click|v. 点击;n. 点击
collaborate|v. 协作
collapse|v. 折叠;崩塌
collision|n. 冲突;碰撞
column|n. 列;栏
combine|v. 合并
commit|v. 提交;n. 提交
compact|adj. 紧凑的
compare|v. 比较
compatible|adj. 兼容的
compensate|v. 补偿
complete|adj. 完整的;v. 完成
complex|adj. 复杂的
complicate|v. 使复杂化
compose|v. 组成;撰写
compress|v. 压缩
concept|n. 概念
conclude|v. 结论;结束
concurrent|adj. 并发的
configure|v. 配置
confirm|v. 确认
conflict|n. 冲突;v. 冲突
conform|v. 符合
consent|n. 同意
consistency|n. 一致性
console|n. 控制台
constraint|n. 约束
consume|v. 消耗
contact|n. 联系;v. 联系
contain|v. 包含
content|n. 内容;目录
contract|n. 合同;契约
contrast|n. 对比;v. 对比
contribute|v. 贡献
convention|n. 约定;惯例
converge|v. 收敛
convert|v. 转换
coordinate|v. 协调;n. 坐标
copy|v. 复制;n. 副本
core|n. 核心;adj. 核心的
coroutine|n. 协程
correct|adj. 正确的;v. 纠正
corrupt|v. 损坏;adj. 腐败的
cost|n. 成本;v. 花费
count|v. 计数;n. 计数
coverage|n. 覆盖率
crawl|v. 爬取
criteria|n. 标准(复数)
critical|adj. 关键的;批评的
cross|adj. 交叉的;v. 穿过
curate|v. 精选;策展
custom|adj. 自定义的
customize|v. 定制
cycle|n. 周期;循环
daemon|n. 守护进程
deadline|n. 截止日期
deallocate|v. 释放
decouple|v. 解耦
dedicated|adj. 专用的
defect|n. 缺陷
defer|v. 延迟;推迟
delegate|v. 委托;n. 委托
deliver|v. 交付
deny|v. 拒绝;否认
depend|v. 依赖
dependency|n. 依赖(项)
deprecate|v. 弃用
derive|v. 派生;推导
detect|v. 检测
determine|v. 确定
diagnose|v. 诊断
diff|n. 差异;v. 对比
digest|n. 摘要;v. 消化
dimension|n. 维度;尺寸
disable|v. 禁用
discard|v. 丢弃
discover|v. 发现
discrete|adj. 离散的
dispatch|v. 分发;调度
display|v. 显示;n. 显示器
dispose|v. 处置;释放
distribute|v. 分发
diverge|v. 分叉
draft|n. 草稿;v. 起草
duplicate|v. 复制;adj. 重复的
dynamic|adj. 动态的
efficient|adj. 高效的
eliminate|v. 消除
emit|v. 发出;发射
empower|v. 赋能;授权
emulate|v. 模拟
enable|v. 启用
encapsulate|v. 封装
encode|v. 编码
encrypt|v. 加密
endpoint|n. 端点
enforce|v. 强制执行
enhance|v. 增强
ensure|v. 确保
entity|n. 实体
entry|n. 条目;入口
enumerate|v. 枚举
envision|v. 展望
equal|adj. 相等的
equip|v. 装备
escape|v. 转义;逃脱;n. 转义
estimate|v. 估计;n. 估计
evaluate|v. 评估
evolve|v. 演化
exceed|v. 超过
exchange|v. 交换;n. 交换
exclude|v. 排除
exclusive|adj. 独占的;排他的
exempt|v. 免除
exhaust|v. 耗尽
expand|v. 展开;扩展
expect|v. 预期
expire|v. 过期
explicit|adj. 显式的
explore|v. 探索
expose|v. 暴露;公开
extend|v. 扩展;继承
external|adj. 外部的
extract|v. 提取;n. 提取物
facilitate|v. 促进
fail|v. 失败
fallback|n. 回退;兜底
fetch|v. 获取
figure|n. 图;数字;v. 认为
finite|adj. 有限的
firmware|n. 固件
fix|v. 修复;n. 修复
flatten|v. 扁平化
flexible|adj. 灵活的
float|n. 浮点数;v. 浮动
flush|v. 刷新;冲刷
fold|v. 折叠;n. 折叠
form|n. 表单;形式;v. 形成
format|n. 格式;v. 格式化
forward|v. 转发;adv. 向前
fragment|n. 片段
frequency|n. 频率
frustrate|v. 挫败
fulfill|v. 履行;满足
gate|n. 门;闸门;关卡
gather|v. 收集
generic|adj. 通用的;泛型的
graceful|adj. 优雅的;平滑的
granular|adj. 细粒度的
grant|v. 授予;n. 授权
graphic|n. 图形;adj. 图形的
guarantee|v. 保证;n. 保证
guard|v. 防护;n. 防护
guideline|n. 指导方针
hack|v. 改编;n. 黑客技巧
halt|v. 停止
hardcode|v. 硬编码
harden|v. 加固
harmony|n. 和谐;协调
headless|adj. 无头的(无界面)
hierarchy|n. 层次;层级
highlight|v. 高亮;n. 高亮
horizontal|adj. 水平的
identical|adj. 相同的
identify|v. 识别
idle|adj. 空闲的
ignore|v. 忽略
illustrate|v. 说明;举例
immutable|adj. 不可变的
impact|n. 影响;v. 冲击
impede|v. 阻碍
implicit|adj. 隐式的
impose|v. 强加
improve|v. 改进
inbox|n. 收件箱
incentivize|v. 激励
increment|n. 增量
indent|v. 缩进;n. 缩进
indicate|v. 指示;表明
infer|v. 推断
infinite|adj. 无限的
infrastructure|n. 基础设施
inherit|v. 继承
inject|v. 注入
inline|adj. 行内的;adv. 内联
innovate|v. 创新
insight|n. 洞察
inspect|v. 检查
inspire|v. 启发
instantiate|v. 实例化
instrument|v. 埋点;n. 仪器
integrate|v. 集成
interact|v. 交互
intercept|v. 拦截
interfere|v. 干扰
intermediate|adj. 中间的
interoperate|v. 互操作
interpret|v. 解释;口译
interrupt|v. 中断
intersect|v. 相交
interval|n. 间隔
intervene|v. 干预
introduce|v. 引入;介绍
invalid|adj. 无效的
invert|v. 反转
invoke|v. 调用;援引
involve|v. 涉及
isolate|v. 隔离
judge|v. 判断;n. 法官
justify|v. 对齐;证明正当
label|n. 标签;v. 标注
landscape|n. 横向;景观
latent|adj. 潜在的
legacy|n. 遗留(系统);adj. 遗留的
license|n. 许可证;v. 许可
lifecycle|n. 生命周期
likelihood|n. 可能性
limit|n. 限制;v. 限制
linear|adj. 线性的
lint|n. 代码检查;v. lint 检查
listener|n. 监听器
literal|n. 字面量;adj. 字面的
locale|n. 区域设置;本地化
locate|v. 定位
logical|adj. 逻辑的
lookup|n. 查找
maintain|v. 维护
manifest|n. 清单;v. 显示
manipulate|v. 操作;操纵
manual|n. 手册;adj. 手动的
margin|n. 边距;页边空白
markup|n. 标记(语言)
mask|v. 掩码;n. 掩码
mature|adj. 成熟的
maximize|v. 最大化
measure|v. 测量;n. 措施
mechanism|n. 机制
medium|n. 媒介;adj. 中等的
memoize|v. 记忆化
mention|v. 提及
metadata|n. 元数据
minimize|v. 最小化
mission|n. 任务;使命
mobile|adj. 移动的
mock|v. 模拟;n. 模拟对象
modular|adj. 模块化的
monotonic|adj. 单调的
mount|v. 挂载
mutate|v. 变更;变异
naming|n. 命名
native|adj. 原生的
navigate|v. 导航
necessary|adj. 必要的
negate|v. 取反;否定
nested|adj. 嵌套的
normalize|v. 归一化;规范化
notation|n. 记号;表示法
notify|v. 通知
numeric|adj. 数值的
observe|v. 观察;遵守
obsolete|adj. 过时的
obtain|v. 获取
occupy|v. 占用
offset|n. 偏移;v. 抵消
omit|v. 省略
onboard|v. 上手;入职
opaque|adj. 不透明的
operand|n. 操作数
optional|adj. 可选的
orchestrate|v. 编排
orient|v. 定向;adj. 定向的
origin|n. 源;起源
outcome|n. 结果
outline|n. 大纲;轮廓
overcome|v. 克服
overlap|v. 重叠;n. 重叠
overload|v. 重载;n. 过载
overlook|v. 忽略;俯瞰
oversee|v. 监督
overwrite|v. 覆盖写入
packet|n. 数据包
parallel|adj. 并行的
parent|n. 父;父级
partial|adj. 部分的
participate|v. 参与
partition|n. 分区;v. 划分
passive|adj. 被动的
pause|v. 暂停;n. 暂停
payload|n. 载荷
peer|n. 对等体;同行
penetrate|v. 穿透
perform|v. 执行;表演
periodic|adj. 周期的
permanent|adj. 永久的
persist|v. 持久化;坚持
perspective|n. 视角;透视
phase|n. 阶段;相位
pick|v. 挑选
pin|v. 固定;n. 引脚
pipe|n. 管道;v. 管道传输
placeholder|n. 占位符
plug|v. 插入;n. 插头
pool|n. 池
populate|v. 填充
portion|n. 部分
pose|v. 构成;摆姿势
position|n. 位置
potential|n. 潜力;adj. 潜在的
precede|v. 先于
precise|adj. 精确的
predefine|v. 预定义
predict|v. 预测
prefer|v. 偏好
prefix|n. 前缀
prepare|v. 准备
preserve|v. 保留;保存
press|v. 按;压
prevent|v. 阻止
previous|adj. 之前的
primary|adj. 主要的;初级的
primitive|n. 原语;adj. 原始的
priority|n. 优先级
privacy|n. 隐私
probe|v. 探测;n. 探针
procedure|n. 过程;程序
proceed|v. 继续进行
prohibit|v. 禁止
promote|v. 提升;促进
prompt|n. 提示;v. 提示
propagate|v. 传播
property|n. 属性;财产
proportion|n. 比例
propose|v. 提议
prospect|n. 前景
protect|v. 保护
provide|v. 提供
provision|v. 供应;n. 供给
publish|v. 发布;出版
punctuation|n. 标点
purge|v. 清除
purpose|n. 目的
pursue|v. 追求
qualify|v. 限定;合格
quality|n. 质量
quantify|v. 量化
race|n. 竞争;竞态
random|adj. 随机的
range|n. 范围
rank|v. 排名;n. 等级
rate|n. 速率;比率;v. 评价
rationale|n. 理由
readable|adj. 可读的
realize|v. 实现;意识到
rebuild|v. 重建
recall|v. 召回;回忆
reconcile|v. 对账;调和
recover|v. 恢复;回收
recursive|adj. 递归的
redundant|adj. 冗余的
refactor|v. 重构
refer|v. 引用;参考
refine|v. 提炼;改进
reflect|v. 反映;反射
refresh|v. 刷新
regenerate|v. 重新生成
register|v. 注册;登记
regression|n. 回归;退化
regulate|v. 调节
reject|v. 拒绝
relate|v. 关联
relative|adj. 相对的
release|v. 发布;释放;n. 版本
relevant|adj. 相关的
reliable|adj. 可靠的
reload|v. 重新加载
rely|v. 依赖
remedy|n. 补救;v. 补救
remote|adj. 远程的;n. 远程
remove|v. 移除
rename|v. 重命名
repair|v. 修复
repeat|v. 重复
replace|v. 替换
replicate|v. 复制
represent|v. 表示
reproduce|v. 复现
rescue|v. 救援
reserve|v. 保留;预订
reset|v. 重置
reside|v. 驻留
resilient|adj. 有韧性的
resort|v. 诉诸;n. 手段
respective|adj. 各自的
respond|v. 响应
restrict|v. 限制
resume|v. 恢复;继续
retain|v. 保留
retire|v. 退役;退休
retrieve|v. 检索;取回
retry|v. 重试
reveal|v. 揭示
reverse|v. 反转;adj. 反向的
revert|v. 还原
revise|v. 修订
revoke|v. 撤销
reward|n. 奖励
robust|adj. 健壮的
rollback|n. 回滚;v. 回滚
rotate|v. 旋转
rough|adj. 粗略的
routine|n. 例程;常规
sample|n. 样本;v. 采样
satisfy|v. 满足
scale|v. 缩放;扩展;n. 规模
scan|v. 扫描
scatter|v. 分散
scenario|n. 场景
scratch|n. 草稿;adj. 临时的
seamless|adj. 无缝的
secure|adj. 安全的;v. 保护
segment|n. 段;分段
sensitive|adj. 敏感的
serialize|v. 序列化
setup|n. 设置;安装
share|v. 共享;n. 份额
sharpen|v. 锐化
shrink|v. 收缩
shutdown|n. 关机;v. 关闭
simplify|v. 简化
simulate|v. 模拟
simultaneous|adj. 同时的
sketch|n. 草图;v. 勾勒
skip|v. 跳过
slash|n. 斜杠
slice|n. 切片;v. 切片
smooth|adj. 平滑的
sole|adj. 唯一的
solid|adj. 可靠的;固体的
solve|v. 解决
sophisticated|adj. 精密的;复杂巧妙的
sort|v. 排序;n. 排序
specify|v. 指定
specification|n. 规格说明
split|v. 拆分;n. 拆分
sponsor|v. 赞助;n. 赞助商
spread|v. 传播;展开
stable|adj. 稳定的
stakeholder|n. 利益相关者
standard|n. 标准;adj. 标准的
startup|n. 启动;初创公司
statistics|n. 统计
steady|adj. 稳定的
steer|v. 引导
stem|v. 源自;n. 词干
stitch|v. 缝合;拼接
straightforward|adj. 直接的
strategy|n. 策略
strengthen|v. 加强
strict|adj. 严格的
stub|n. 桩;存根
subsequent|adj. 随后的
subset|n. 子集
substitute|v. 替代;n. 替代品
subtle|adj. 微妙的
succeed|v. 成功;继承
sufficient|adj. 充足的
suggest|v. 建议
suitable|adj. 合适的
summary|n. 摘要
supervise|v. 监督
supplement|v. 补充;n. 补充
supply|v. 供应
suppress|v. 抑制
suspect|v. 怀疑;n. 嫌疑人
suspend|v. 挂起;暂停
sustain|v. 维持
swap|v. 交换
switch|v. 切换;n. 开关
symbol|n. 符号
symmetry|n. 对称
synchronize|v. 同步
synthesize|v. 合成
systematic|adj. 系统的
tackle|v. 处理
tailor|v. 定制
tap|v. 轻敲;n. 轻敲
technical|adj. 技术的
temporary|adj. 临时的
tend|v. 倾向于
terminate|v. 终止
territory|n. 领域;领土
threshold|n. 阈值
throughput|n. 吞吐量
tight|adj. 紧密的
timely|adj. 及时的
toggle|v. 切换;n. 开关
tolerant|adj. 容错的;容忍的
track|v. 跟踪;n. 轨道
tradeoff|n. 权衡
traditional|adj. 传统的
transaction|n. 事务;交易
transfer|v. 传输;转移
transform|v. 变换
transient|adj. 瞬态的
transparent|adj. 透明的
trim|v. 裁剪;n. 裁剪
trivial|adj. 平凡的;微不足道的
trust|v. 信任;n. 信任
tune|v. 调优
turn|v. 转动;n. 轮流
typical|adj. 典型的
ubiquitous|adj. 无处不在的
underlying|adj. 底层的
undo|v. 撤销
uniform|adj. 统一的
unique|adj. 唯一的
unit|n. 单元;单位
unstable|adj. 不稳定的
upgrade|v. 升级;n. 升级
upper|adj. 上面的
usage|n. 用法;使用
utility|n. 工具;效用
utilize|v. 利用
valuable|adj. 有价值的
various|adj. 各种的
verbose|adj. 冗长的
verify|v. 校验
vertical|adj. 垂直的
viable|adj. 可行的
vibrant|adj. 有活力的
violate|v. 违反
visible|adj. 可见的
vision|n. 愿景;视觉
visual|adj. 视觉的
vital|adj. 至关重要的
volatile|adj. 易变的;不稳定的
vulnerable|adj. 脆弱的;易受攻击的
watchdog|n. 看门狗
wear|v. 磨损;穿戴
well|adv. 很好地;n. 井
whitelist|n. 白名单
widespread|adj. 广泛的
wipe|v. 擦除
wisdom|n. 智慧
worth|adj. 值得的;n. 价值
wrap|v. 包装;n. 包装
yield|v. 产出;让步;n. 产量
zoom|v. 缩放;n. 缩放
# --- 常用短语/搭配 ---
thank you|谢谢
you are welcome|不客气
good morning|早上好
good night|晚安
how are you|你好吗
see you|再见
for example|例如
as well as|以及
in fact|事实上
of course|当然
at least|至少
at most|最多
in general|总的来说
on the other hand|另一方面
by the way|顺便说一下
in other words|换句话说
step by step|一步一步
best practice|最佳实践
use case|用例
edge case|边界情况
code review|代码评审
pull request|拉取请求(PR)
commit message|提交信息
breaking change|破坏性变更
backward compatible|向后兼容
out of the box|开箱即用
under the hood|底层机制
on demand|按需
in advance|提前
up to date|最新的
state of the art|最先进的
trade off|权衡
root cause|根本原因
work around|变通方案
fallback plan|备选计划
in production|在生产环境中
real world|真实世界
end to end|端到端
point of view|观点
so far|到目前为止
right now|现在
as soon as possible|尽快
more or less|差不多
`;

/** 解析原始数据为词条(跳过空行与 `#` 注释行) */
function parse(raw: string): RawEntry[] {
  const out: RawEntry[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const bar = t.indexOf('|');
    if (bar <= 0) continue;
    const word = t.slice(0, bar).trim().toLowerCase();
    const defs = t
      .slice(bar + 1)
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean);
    if (word && defs.length) out.push({ word, defs });
  }
  return out;
}

const ENTRIES: RawEntry[] = parse(RAW);

/** 英文词条索引(小写) */
const EN_MAP = new Map<string, string[]>();
/** 中文释义反查索引(剥离词性前缀) */
const ZH_MAP = new Map<string, string[]>();

const POS_PREFIX = /^[a-z]+\.\s+/;

for (const e of ENTRIES) {
  EN_MAP.set(e.word, e.defs);
  for (const d of e.defs) {
    const zh = d.replace(POS_PREFIX, '').trim();
    if (!zh) continue;
    // 同一释义可能对应多个英文词,合并
    const arr = ZH_MAP.get(zh);
    if (arr) {
      if (!arr.includes(e.word)) arr.push(e.word);
    } else {
      ZH_MAP.set(zh, [e.word]);
    }
  }
}

export interface DictHit {
  /** 实际命中的词典键(可能与查询不同,如复数还原后) */
  key: string;
  defs: string[];
}

export interface OfflineLookup {
  /** 归一化后的查询词 */
  query: string;
  /** 是否中文查询 */
  cjk: boolean;
  /** 直接命中(含词形还原) */
  hits: DictHit[];
  /** 中文反查命中的英文词 */
  reverse: string[];
  /** 未命中时的近似建议 */
  suggestions: string[];
}

/** 归一化:去首尾空白与常见包裹符号,压缩内部空白 */
export function normalizeQuery(raw: string): string {
  return raw
    .trim()
    .replace(/^[\s"'“”‘’()[\]{}<>《》【】（）]+/, '')
    .replace(/[\s"'“”‘’()[\]{}<>《》【】（）]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const CJK_RE = /[\u4e00-\u9fff]/;

/** 英文词形还原候选:复数 / 进行时 / 过去式 / 比较级 / 派生 */
function inflectionCandidates(w: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (s.length >= 2 && !out.includes(s)) out.push(s);
  };
  // 复数 / 三单
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('es')) add(w.slice(0, -2));
  if (w.endsWith('s') && !w.endsWith('ss')) add(w.slice(0, -1));
  // 进行时 / 动名词
  if (w.endsWith('ing')) {
    add(w.slice(0, -3));
    add(w.slice(0, -3) + 'e');
    if (w.length > 4 && w[w.length - 4] === w[w.length - 5]) add(w.slice(0, -4)); // running → run
  }
  // 过去式 / 过去分词
  if (w.endsWith('ied')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ed')) {
    add(w.slice(0, -2));
    add(w.slice(0, -1));
    if (w.length > 3 && w[w.length - 3] === w[w.length - 4]) add(w.slice(0, -3)); // stopped → stop
  }
  // 副词
  if (w.endsWith('ily')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('ly')) add(w.slice(0, -2));
  // 比较级 / 最高级
  if (w.endsWith('er')) add(w.slice(0, -2));
  if (w.endsWith('ier')) add(w.slice(0, -3) + 'y');
  if (w.endsWith('est')) add(w.slice(0, -3));
  if (w.endsWith('iest')) add(w.slice(0, -4) + 'y');
  return out;
}

/** 前缀/子串近似建议(未命中时给出,按长度升序) */
function suggest(w: string, limit = 6): string[] {
  if (w.length < 2) return [];
  const scored: Array<{ k: string; score: number }> = [];
  for (const k of EN_MAP.keys()) {
    let score = 0;
    if (k === w) continue;
    if (k.startsWith(w)) score = 3;
    else if (k.includes(w)) score = 2;
    else if (w.startsWith(k) && k.length >= 3) score = 1;
    if (score > 0) scored.push({ k, score });
  }
  scored.sort((a, b) => b.score - a.score || a.k.length - b.k.length);
  return scored.slice(0, limit).map((s) => s.k);
}

/** 离线查词:英文(含词形还原)或中文(反查) */
export function lookupOffline(rawQuery: string): OfflineLookup {
  const query = normalizeQuery(rawQuery);
  const cjk = CJK_RE.test(query);
  const hits: DictHit[] = [];
  const reverse: string[] = [];

  if (cjk) {
    // 中文反查:精确 → 包含(限量)
    const exact = ZH_MAP.get(query);
    if (exact) reverse.push(...exact);
    if (reverse.length < 8) {
      let n = 0;
      for (const [zh, words] of ZH_MAP) {
        if (zh !== query && zh.includes(query)) {
          for (const w of words) if (!reverse.includes(w)) reverse.push(w);
          if (++n > 400) break; // 含子串的扫描设上限,防超大选区拖慢
        }
        if (reverse.length >= 8) break;
      }
    }
    return { query, cjk, hits, reverse, suggestions: [] };
  }

  if (!query) return { query, cjk, hits, reverse, suggestions: [] };

  // 多词短语:整串精确命中(如 "thank you")
  const phrase = EN_MAP.get(query);
  if (phrase) hits.push({ key: query, defs: phrase });

  // 单词:精确 → 词形还原
  if (!hits.length && !query.includes(' ')) {
    const direct = EN_MAP.get(query);
    if (direct) hits.push({ key: query, defs: direct });
    else {
      for (const cand of inflectionCandidates(query)) {
        const hit = EN_MAP.get(cand);
        if (hit) {
          hits.push({ key: cand, defs: hit });
          break;
        }
      }
    }
  }

  return {
    query,
    cjk,
    hits,
    reverse,
    suggestions: hits.length ? [] : suggest(query),
  };
}

/** 词典规模(测试与设置页展示用) */
export function dictionarySize(): number {
  return ENTRIES.length;
}
