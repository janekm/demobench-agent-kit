# DB32 gpu-1 implementation contract

This is the normative incremental profile for CPU + programmable GPU + video. Cartridge version 2 (`.profile gpu-1`) enables GPU MMIO. Version 1 remains bootstrap-1 and GPU accesses still fault. ABI stays 1 with additive GPU telemetry exports. RAM, 4096-byte payload limit, CPU ISA, and 204800 ticks/frame are unchanged. No GPU instruction draws an object or knows a scene: kernels implement traversal, materials, lighting, and bounce control.

## Processor and execution

64 lanes/wave; one resident wave; 32 u32 registers per lane (`g0` always zero); lane-local absolute ROM PCs; finite row-major grid up to 160*120 invocations (width 1..160, height 1..120). Each wave resets registers and PC. Select the minimum PC of unfinished valid lanes; execute that instruction for all lanes currently at that PC. This deterministic cohort rule handles divergent branches without an unbounded stack. Tail lanes never execute. A dispatch has a hard 1048576-tick budget, including setup. Infinite loops fault. No calls, atomics, barriers, local memory, host functions or implicit queues.

At START validate immutable ROM code range/alignment and decode boundaries, grid, bindings and uniforms. All code/scene constants count toward payload. Kernel code must be ROM, at most 4096 bytes; literal words are never executable targets. Branches may target only instruction boundaries inside this dispatch. Two-word instructions must be complete. All operands/reserved bits are validated, even for unexecuted instructions. Code fetch never escapes the submitted range.

Instruction issue reads register/memory state. Effects commit at the instruction completion tick. All lanes read before any lane writes; stores commit in ascending lane order (higher active lane wins overlaps). Inactive lanes cannot fault or access memory. A fault aborts this instruction without partial register or memory effects; diagnostics identify PC/lane/address. Dispatch completion releases bindings. At equal ticks: CPU commit, GPU commit, video event; next CPU/GPU issue follows these events. CPU HALT/WFI does not stop the GPU. In gpu-1, WFI wakes on vblank or GPU completion; in bootstrap-1 it retains vblank-only behavior. This is a wake event, not a general vectored interrupt controller.

Costs per cohort: regular scalar/vector ALU, branch, constants, built-ins, comparisons, conversions, END = 1 tick; loads/stores/RGB = 2; fdiv/sqrt/rsqrt/norm3 = 4; sphere = 8. Dot/reflect cost 2. Dispatch setup 16; wave setup 4 (also first wave). No free runs to completion. GPU virtual ticks and host wall throughput are reported separately; 60 Hz means a completed full-frame dispatch within 204800 virtual ticks AND measured host throughput near/beyond 60 frames/second, where verified.

## MMIO at 0xf3000 (aligned u32 only)

- +0 kernel ROM base, +4 kernel byte length, +8 width, +12 height.
- +16 START: write 1; reject busy or other values.
- +20 STATUS RO: 0 idle, 1 busy, 2 done, 3 fault.
- +24 last/current dispatch elapsed ticks RO; +28 completed dispatch count RO.
- +32 completed invocations in current/last dispatch RO; +36 current cohort PC RO.
- +40 last dispatch duration RO (remains previous while busy).
- +44 feature ID RO = 0x00010001.
- +0x40..0x7f four descriptors, each 16 bytes: base, byte length, flags, reserved zero. flags 0=unused (all fields zero); 1=read-only; 3=read/write. RO may address ROM or RAM; RW must address RAM. No overlaps between used bindings. Length >0. All arithmetic/ranges checked.
- +0x100..0x13f sixteen uniform words, raw u32/f32 bits.
- Unknown/RO writes fault. All config writes reject while busy. START validates and latches config, so subsequent CPU writes cannot change active state.

While busy, CPU writes into any RAM binding and CPU reads/fetches from an RW binding fault. RO CPU reads are allowed. GPU bindings cannot alias code since code is ROM. Video is an observer and may scan GPU output; applications use two RGB888 buffers (57600 bytes each) and commit page flips at vblank for completed frames. CPU commit-time lease rechecks close races with GPU start/completion.

## Instruction encoding and assembler

GPU mnemonics have `g.` prefix and registers g0..g31. All instructions are 32-bit words: opcode bits0..7, rd8..12, ra13..17, rb18..22, rc23..27, bits28..31 zero. Unused fields must be zero. `g.li`, `g.bz`, `g.bnz`, `g.jmp` additionally consume a following 32-bit literal. Literals include complete float bits or absolute ROM branch addresses. `.float` emits finite IEEE binary32 constants; `g.fli gD, decimal` is `g.li` with float bits. CPU `.entry` cannot point into a GPU instruction or literal. Integer `g.li` accepts labels/expressions. GPU/code/data share the same counted payload.

| Opcode | Syntax | Semantics |
|---:|---|---|
|0|g.end|finish cohort lanes|
|1|g.li d, u32|next word is literal|
|2|g.mov d,a|copy bits|
|3|g.id d, n|ra=n: 0=x, 1=y, 2=linear ID, 3=lane ID, 4=width, 5=height|
|4|g.uniform d,n|ra=n, 0..15; latched raw word|
|5|g.add d,a,b|wrap32|
|6|g.sub d,a,b|wrap32|
|7|g.mul d,a,b|wrap32 low word|
|8|g.and d,a,b|bitwise|
|9|g.or d,a,b|bitwise|
|10|g.xor d,a,b|bitwise|
|11|g.shl d,a,b|b&31|
|12|g.shr d,a,b|logical b&31|
|13|g.sar d,a,b|signed b&31|
|14|g.slt d,a,b|signed integer 0/1|
|15|g.sltu d,a,b|unsigned integer 0/1|
|16|g.fadd d,a,b|binary32 addition|
|17|g.fsub d,a,b|binary32 subtraction|
|18|g.fmul d,a,b|binary32 multiplication|
|19|g.fdiv d,a,b|binary32 division|
|20|g.fmin d,a,b|finite min|
|21|g.fmax d,a,b|finite max|
|22|g.sqrt d,a|binary32 square root|
|23|g.rsqrt d,a|1/sqrt(a)|
|24|g.itof d,a|signed i32 -> binary32|
|25|g.ftoi d,a|truncate toward zero, saturate to i32 bounds|
|26|g.flt d,a,b|float less-than 0/1|
|27|g.fle d,a,b|float <= 0/1|
|28|g.vadd d,a,b|three consecutive float registers componentwise add|
|29|g.vsub d,a,b|vec3 subtract|
|30|g.vscale d,a,b|vec3 a times scalar b|
|31|g.dot3 d,a,b|((ax*bx)+(ay*by))+(az*bz), individually rounded|
|32|g.norm3 d,a|vec3 / sqrt(dot3), zero vector -> zero vector|
|33|g.reflect3 d,a,b|a - 2*dot(a,b)*b; b is kernel-supplied unit normal|
|34|g.sphere d,a,b,c|ray origin vec3 a, direction vec3 b, center xyz/radius at c..c+3; nearest t>=1/1024, else -1. General quadratic a=dot(D,D), b=dot(O-C,D), c=dot(O-C,O-C)-r*r; disc=b*b-a*c. Zero direction or negative radius faults. Try near then far positive root. No scene lookup, BVH, colour, occlusion or bounce behavior.|
|35|g.ld d,a,n|binding rb=n (0..3); aligned 4-byte load at byte offset in a|
|36|g.st d,a,n|store bits from d at binding offset a|
|37|g.ldb d,a,n|unsigned byte load|
|38|g.stb d,a,n|low-byte store|
|39|g.rgb d,a,n|RGB888 store: float vec3 d clamped0..1, multiply255, truncate to u8, alpha absent; linear pixel index in a, binding rb=n. Address = index*3 with overflow/bounds checking.|
|40|g.bz a,label|rd=a, next word absolute target; each lane branches if its u32 equals0|
|41|g.bnz a,label|rd=a, next word target; branch if nonzero|
|42|g.jmp label|all fields zero, next word target|

Vector sources must fit registers (start<=29; sphere c<=28), destinations start1..29. Scalar d=0 discards result. IEEE signed zero is preserved; fmin of mixed signed zeros is -0, fmax is +0. Float inputs/results must be finite or deterministic arithmetic fault (including overflow/divide0); no NaN payload nondeterminism. No fused operations, fast-math, transcendental approximations or hidden native scene renderer. Float helper steps use binary32 in written order. `g.sphere` uses sqrt of nonnegative disc, both roots divided by a. Negative disc returns -1. `g.norm3` sums x*x + y*y + z*z in that order. Memory returns raw bits and only float consumers validate them.
