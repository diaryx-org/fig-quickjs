str     = "a \"q\" \\ \n é \U0001F600"
tpl     = "x-${var.y}-%{ if a }b%{ endif }"
lit     = "$${not} %%{tpl}"
int     = 42
neg     = -7
float   = 1.5
exp     = 2e10
t       = true
f       = false
n       = null
empty_l = []
empty_o = {}
multi = [
  1, # one
  "two",
  [3],
  { k = "v" },
]
obj = {
  a = 1
  "b c" = 2, d: 3
}
here = <<EOF
raw ${x}
  kept
EOF
call  = max(1, 2)
index = var.list[0]
cond  = a ? b : c
arith = 1 + 2 * 3
str_op = "a" == var.b
for_t = [for x in y : x]
for_o = { for k, v in m : k => v }
multi_call = join(",",
  [a, b]
)
