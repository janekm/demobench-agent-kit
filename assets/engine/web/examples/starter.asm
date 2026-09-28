; Minimal CPU RGB888 starter: a red ramp across framebuffer bytes.
.profile bootstrap-1
.entry start
start:
    li r1, 0x10000
    li r2, 0x1e100          ; end of 160*120*3 byte buffer
paint:
    sb r1, 0(r1)
    addi r1, r1, 3
    bltu r1, r2, paint

    li r1, 0xf5000          ; video registers
    li r2, 0x10000
    sw r2, 0(r1)            ; framebuffer
    li r2, 480
    sw r2, 4(r1)            ; bytes per row
    li r2, 4
    sw r2, 8(r1)            ; RGB888
    li r2, 1
    sw r2, 16(r1)           ; enable
    sw r2, 20(r1)           ; queue configuration for vblank
    halt
