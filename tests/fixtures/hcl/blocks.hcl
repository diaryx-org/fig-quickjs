// one-line
empty {}
one { a = 1 }

labeled "x" {}
labeled "y" {
  n = 1
}
labeled "x" {
  n = 2
}

deep a "b" "c" { v = 1 }
deep a "b" "d" { v = 2 }

nested {
  inner {
    leaf = true
  }
  # after inner
  inner {}
  attr = 1 /* trailing block */
} # after close
