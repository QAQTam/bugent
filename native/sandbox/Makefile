# libbugent-sandbox build
#
# The normal entry point is:
#   bun run build:sandbox
#
# Direct Make usage is kept for downstream packagers.

CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -Werror
LDFLAGS ?= -shared -Wl,-z,relro,-z,now
OUTPUT ?= build/libbugent-sandbox.so

.PHONY: all clean

all: $(OUTPUT)

$(OUTPUT): provider.c
	@mkdir -p $(dir $@)
	$(CC) -fPIC $(CFLAGS) $(LDFLAGS) -o $@ $<

clean:
	rm -rf build
