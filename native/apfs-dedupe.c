// Arkive's fixed macOS helper. No shell, directory traversal, or ordinary-copy fallback.
// prepare never changes the destination; commit uses an atomic exchange and retains
// the old inode until post-exchange verification. Recovery never discards changed data.
#include <copyfile.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/acl.h>
#include <sys/attr.h>
#include <sys/clonefile.h>
#include <sys/file.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/xattr.h>
#include <unistd.h>

static void fail(const char *message) {
    fprintf(stderr, "%s (%s)\n", message, strerror(errno));
    exit(1);
}
static void require(int condition, const char *message) {
    if (!condition) { errno = EINVAL; fail(message); }
}
static void check(int result, const char *message) { if (result < 0) fail(message); }

// Resolve each directory component with NOFOLLOW, including parent components.
static int directory(const char *path) {
    require(path[0] == '/', "absolute paths required");
    char *copy = strdup(path), *rest = copy, *part;
    require(copy != NULL, "allocation failed");
    int fd = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    check(fd, "open root");
    while ((part = strsep(&rest, "/"))) {
        if (!*part) continue;
        require(strcmp(part, ".") && strcmp(part, ".."), "noncanonical path");
        int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        check(next, "open directory without following symlinks");
        close(fd);
        fd = next;
    }
    free(copy);
    return fd;
}
static int parent(const char *path, char **leaf) {
    char *copy = strdup(path);
    require(copy != NULL, "allocation failed");
    char *slash = strrchr(copy, '/');
    require(slash && slash[1], "file path required");
    *leaf = strdup(slash + 1);
    require(*leaf && strcmp(*leaf, ".") && strcmp(*leaf, ".."), "invalid leaf");
    if (slash == copy) slash[1] = 0; else *slash = 0;
    int fd = directory(copy);
    free(copy);
    return fd;
}
static struct stat info(int fd) {
    struct stat result;
    check(fstat(fd, &result), "fstat");
    return result;
}
static int same_inode(struct stat a, struct stat b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}
static int same_time(struct timespec a, struct timespec b) {
    return a.tv_sec == b.tv_sec && a.tv_nsec == b.tv_nsec;
}
static int stable(struct stat a, struct stat b) {
    return same_inode(a, b) && a.st_size == b.st_size && a.st_nlink == b.st_nlink &&
        a.st_mode == b.st_mode && a.st_uid == b.st_uid && a.st_gid == b.st_gid &&
        a.st_flags == b.st_flags && same_time(a.st_mtimespec, b.st_mtimespec) &&
        same_time(a.st_ctimespec, b.st_ctimespec);
}
static int open_regular(int dir, const char *leaf) {
    int fd = openat(dir, leaf, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    check(fd, "open file without following symlink");
    struct stat s = info(fd);
    require(S_ISREG(s.st_mode), "only regular files supported");
    return fd;
}
static void lock_file(int fd) { check(flock(fd, LOCK_EX | LOCK_NB), "file is busy"); }
static void sync_directory(int fd) { check(fsync(fd), "sync directory"); }

static uint64_t clone_id(int fd) {
    struct attrlist attrs = { .bitmapcount = ATTR_BIT_MAP_COUNT,
        .commonattr = ATTR_CMN_RETURNED_ATTRS, .forkattr = ATTR_CMNEXT_CLONEID };
    // getattrlist uses 4-byte packing, including 64-bit values.
    struct __attribute__((packed, aligned(4))) {
        uint32_t length;
        attribute_set_t returned;
        uint64_t id;
    } value = {0};
    if (fgetattrlist(fd, &attrs, &value, sizeof(value), FSOPT_ATTR_CMN_EXTENDED) < 0 ||
        !(value.returned.forkattr & ATTR_CMNEXT_CLONEID)) return 0;
    return value.id;
}
static int equal_data(int a, int b) {
    struct stat sa = info(a), sb = info(b);
    if (sa.st_size != sb.st_size) return 0;
    char left[262144], right[262144];
    for (off_t offset = 0; offset < sa.st_size;) {
        size_t amount = (size_t)(sa.st_size - offset);
        if (amount > sizeof(left)) amount = sizeof(left);
        ssize_t na = pread(a, left, amount, offset), nb = pread(b, right, amount, offset);
        if (na < 0 || nb < 0) fail("read content");
        if (na != (ssize_t)amount || nb != na || memcmp(left, right, amount)) return 0;
        offset += na;
    }
    return 1;
}
static char *xattrs(int fd, ssize_t *size) {
    *size = flistxattr(fd, NULL, 0, 0);
    check((int)*size, "list extended attributes");
    char *names = calloc((size_t)*size + 1, 1);
    require(names != NULL, "allocation failed");
    require(flistxattr(fd, names, (size_t)*size, 0) == *size, "extended attributes changed");
    return names;
}
static int equal_xattrs(int a, int b) {
    ssize_t alen, blen;
    char *anames = xattrs(a, &alen), *bnames = xattrs(b, &blen);
    int equal = alen == blen;
    for (ssize_t i = 0; equal && i < alen; i += (ssize_t)strlen(anames + i) + 1) {
        const char *name = anames + i;
        ssize_t size = fgetxattr(a, name, NULL, 0, 0, 0);
        if (size < 0) fail("read extended attribute");
        if (fgetxattr(b, name, NULL, 0, 0, 0) != size) { equal = 0; break; }
        char *left = malloc((size_t)size + 1), *right = malloc((size_t)size + 1);
        require(left && right, "allocation failed");
        require(fgetxattr(a, name, left, (size_t)size, 0, 0) == size, "attribute changed");
        equal = fgetxattr(b, name, right, (size_t)size, 0, 0) == size &&
            !memcmp(left, right, (size_t)size);
        free(left); free(right);
    }
    free(anames); free(bnames);
    return equal;
}
static acl_t file_acl(int fd) {
    acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    if (!acl && errno == ENOENT) acl = acl_init(0);
    if (!acl) fail("read ACL");
    return acl;
}
static int equal_metadata(int a, int b) {
    struct stat sa = info(a), sb = info(b);
    if (sa.st_mode != sb.st_mode || sa.st_uid != sb.st_uid || sa.st_gid != sb.st_gid ||
        sa.st_flags != sb.st_flags || !same_time(sa.st_mtimespec, sb.st_mtimespec) ||
        !same_time(sa.st_birthtimespec, sb.st_birthtimespec)) return 0;
    acl_t aa = file_acl(a), ab = file_acl(b);
    ssize_t alen, blen;
    char *atext = acl_to_text(aa, &alen), *btext = acl_to_text(ab, &blen);
    require(atext && btext, "serialize ACL");
    int equal = alen == blen && !memcmp(atext, btext, (size_t)alen);
    acl_free(atext); acl_free(btext);
    acl_free(aa); acl_free(ab);
    return equal && equal_xattrs(a, b);
}
static void copy_metadata(int from, int to) {
    ssize_t size;
    char *names = xattrs(to, &size);
    for (ssize_t i = 0; i < size; i += (ssize_t)strlen(names + i) + 1)
        check(fremovexattr(to, names + i, 0), "remove inherited source attribute");
    free(names);
    check(fcopyfile(from, to, NULL, COPYFILE_METADATA), "preserve destination metadata");
    struct stat s = info(from);
    // Explicitly preserve birth/modify/access times; ctime and inode necessarily change.
    struct attrlist attrs = { .bitmapcount = ATTR_BIT_MAP_COUNT,
        .commonattr = ATTR_CMN_CRTIME | ATTR_CMN_MODTIME | ATTR_CMN_ACCTIME };
    struct timespec times[] = { s.st_birthtimespec, s.st_mtimespec, s.st_atimespec };
    check(fsetattrlist(to, &attrs, times, sizeof(times), 0), "preserve timestamps");
    require(equal_metadata(from, to), "metadata verification failed");
}

struct journal {
    uint64_t magic;
    struct stat original;
    struct stat candidate;
};
static const uint64_t magic = 0x41524b4445445531ULL;
static void save_journal(int dir, struct journal state) {
    int fd = openat(dir, "state", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    check(fd, "create recovery state");
    require(write(fd, &state, sizeof(state)) == sizeof(state), "write recovery state");
    check(fsync(fd), "sync recovery state");
    close(fd);
    sync_directory(dir);
}
static struct journal load_journal(int dir) {
    struct journal state;
    int fd = openat(dir, "state", O_RDONLY | O_NOFOLLOW);
    check(fd, "open recovery state");
    require(read(fd, &state, sizeof(state)) == sizeof(state) && state.magic == magic,
        "invalid recovery state; retain all files");
    close(fd);
    return state;
}
static void cleanup(int dir) {
    if (unlinkat(dir, "candidate", 0) < 0 && errno != ENOENT) fail("remove transaction file");
    if (unlinkat(dir, "state", 0) < 0 && errno != ENOENT) fail("remove recovery state");
    sync_directory(dir);
}

static void prepare(int source, int target, int transaction) {
    lock_file(source); lock_file(target);
    struct stat sa = info(source), sb = info(target);
    struct statfs fs;
    check(fstatfs(target, &fs), "read filesystem");
    require(!strcmp(fs.f_fstypename, "apfs") && sa.st_dev == sb.st_dev,
        "same APFS volume required");
    require(sa.st_nlink == 1 && sb.st_nlink == 1, "hard-linked files are skipped");
    require(!sa.st_flags && !sb.st_flags, "flagged/compressed/dataless files are skipped");
    require(!same_inode(sa, sb), "same file");
    require(sa.st_size > 0 && sa.st_size == sb.st_size, "nonempty equal-size files required");
    check(fclonefileat(source, transaction, "candidate", 0), "APFS clone failed");
    int initial = open_regular(transaction, "candidate");
    check(fchmod(initial, 0600), "make private clone writable for metadata");
    close(initial);
    int candidate = openat(transaction, "candidate", O_RDWR | O_NOFOLLOW);
    check(candidate, "open clone");
    require(equal_data(candidate, target), "file contents differ; target unchanged");
    require(stable(sa, info(source)) && stable(sb, info(target)), "file changed during validation");
    uint64_t a = clone_id(source), b = clone_id(target);
    if (a && a == b) {
        cleanup(transaction);
        puts("{\"status\":\"skipped\",\"reason\":\"same-clone-family\"}");
        return;
    }
    copy_metadata(target, candidate);
    check(fsync(candidate), "sync verified clone");
    require(stable(sb, info(target)), "target changed while preserving metadata");
    save_journal(transaction, (struct journal){ magic, info(target), info(candidate) });
    printf("{\"status\":\"prepared\",\"sizeBytes\":%lld}\n", (long long)sb.st_size);
    close(candidate);
}

static void commit(int target_dir, const char *leaf, int transaction) {
    struct journal state = load_journal(transaction);
    int target = open_regular(target_dir, leaf), candidate = open_regular(transaction, "candidate");
    lock_file(target); lock_file(candidate);
    require(stable(state.original, info(target)) && stable(state.candidate, info(candidate)),
        "file changed since preparation; target unchanged");
    require(equal_data(target, candidate) && equal_metadata(target, candidate),
        "content or metadata changed; target unchanged");
    require(stable(state.original, info(target)) && stable(state.candidate, info(candidate)),
        "file changed during final verification; target unchanged");
    // The original always remains at one name. No unlink-then-rename window.
    check(renameatx_np(transaction, "candidate", target_dir, leaf, RENAME_SWAP), "atomic exchange");
    sync_directory(target_dir); sync_directory(transaction);
    struct stat published, retained;
    check(fstatat(target_dir, leaf, &published, AT_SYMLINK_NOFOLLOW), "verify published path");
    check(fstatat(transaction, "candidate", &retained, AT_SYMLINK_NOFOLLOW), "verify retained path");
    require(same_inode(published, state.candidate) && same_inode(retained, state.original),
        "concurrent path change; retain both files for recovery");
    struct stat old_before = info(target), new_before = info(candidate);
    require(equal_data(target, candidate) && equal_metadata(target, candidate),
        "concurrent content change; retain both files for recovery");
    require(stable(old_before, info(target)) && stable(new_before, info(candidate)),
        "file changed during post-exchange verification; retain both versions");
    check(fstatat(target_dir, leaf, &published, AT_SYMLINK_NOFOLLOW), "recheck published path");
    check(fstatat(transaction, "candidate", &retained, AT_SYMLINK_NOFOLLOW), "recheck retained path");
    require(same_inode(published, state.candidate) && same_inode(retained, state.original),
        "path changed after exchange; retain both files");
    // candidate fd is the published clone; target fd is the retained old inode.
    cleanup(transaction);
    printf("{\"status\":\"deduplicated\",\"sizeBytes\":%lld}\n", (long long)state.original.st_size);
    close(target); close(candidate);
}

static void recover(int target_dir, const char *leaf, int transaction) {
    struct stat state_file;
    if (fstatat(transaction, "state", &state_file, AT_SYMLINK_NOFOLLOW) < 0) {
        require(errno == ENOENT, "read transaction state");
        // No exchange can occur before the state has been fsynced.
        cleanup(transaction);
        puts("{\"status\":\"recovered\"}");
        return;
    }
    struct journal state = load_journal(transaction);
    int target = open_regular(target_dir, leaf);
    lock_file(target);
    struct stat current = info(target), other;
    if (fstatat(transaction, "candidate", &other, AT_SYMLINK_NOFOLLOW) < 0) {
        require(errno == ENOENT && same_inode(current, state.candidate),
            "ambiguous recovery; retain all files");
        // Successful commit removed the old inode but was interrupted during cleanup.
    } else if (same_inode(current, state.original) && same_inode(other, state.candidate)) {
        // Preparation was interrupted, or the exchange was already rolled back.
    } else {
        require(same_inode(current, state.candidate) && same_inode(other, state.original),
            "path changed; retain both files for manual recovery");
        int original = open_regular(transaction, "candidate");
        lock_file(original);
        struct stat before_current = info(target), before_original = info(original);
        require(equal_data(target, original) && equal_metadata(target, original),
            "files changed after interruption; retain both versions for manual recovery");
        require(stable(before_current, info(target)) && stable(before_original, info(original)),
            "files changed during recovery; retain both versions");
        check(renameatx_np(transaction, "candidate", target_dir, leaf, RENAME_SWAP), "restore original");
        sync_directory(target_dir); sync_directory(transaction);
        struct stat restored, exchanged;
        check(fstatat(target_dir, leaf, &restored, AT_SYMLINK_NOFOLLOW), "verify restored path");
        check(fstatat(transaction, "candidate", &exchanged, AT_SYMLINK_NOFOLLOW), "verify exchanged path");
        require(same_inode(restored, state.original) && same_inode(exchanged, state.candidate),
            "concurrent path change during recovery; retain both files");
        close(original);
    }
    cleanup(transaction);
    puts("{\"status\":\"recovered\"}");
    close(target);
}

int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--version")) { puts("arkive-apfs-dedupe 1"); return 0; }
    if (argc == 4 && !strcmp(argv[1], "inspect")) {
        char *left, *right;
        int ld = parent(argv[2], &left), rd = parent(argv[3], &right);
        int a = open_regular(ld, left), b = open_regular(rd, right);
        printf("{\"sourceCloneId\":\"%llu\",\"targetCloneId\":\"%llu\"}\n",
            (unsigned long long)clone_id(a), (unsigned long long)clone_id(b));
        close(a); close(b); close(ld); close(rd); free(left); free(right);
        return 0;
    }
    require(argc == 5, "usage: apfs-dedupe prepare|commit|recover source target transaction");
    // Parent cancellation is handled between commands; never terminate an exchange midway.
    signal(SIGTERM, SIG_IGN); signal(SIGINT, SIG_IGN);
    char *leaf;
    int target_dir = parent(argv[3], &leaf), transaction = directory(argv[4]);
    struct stat tx = info(transaction);
    require(tx.st_uid == getuid() && (tx.st_mode & 0777) == 0700, "private transaction required");
    // A surviving helper may outlive its Electron owner. Even before a state file
    // exists, recovery must never delete that helper's in-progress candidate.
    lock_file(transaction);
    acl_t private_acl = acl_init(0);
    require(private_acl != NULL, "create private directory ACL");
    check(acl_set_fd_np(transaction, private_acl, ACL_TYPE_EXTENDED), "remove inherited transaction ACL");
    acl_free(private_acl);
    int tx_parent = openat(transaction, "..", O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    check(tx_parent, "open transaction parent");
    require(same_inode(info(tx_parent), info(target_dir)), "transaction must be beside target");
    if (!strcmp(argv[1], "prepare")) {
        char *source_leaf;
        int source_dir = parent(argv[2], &source_leaf);
        int source = open_regular(source_dir, source_leaf), target = open_regular(target_dir, leaf);
        prepare(source, target, transaction);
        close(source); close(target); close(source_dir); free(source_leaf);
    } else if (!strcmp(argv[1], "commit")) commit(target_dir, leaf, transaction);
    else if (!strcmp(argv[1], "recover")) recover(target_dir, leaf, transaction);
    else require(0, "unknown operation");
    close(tx_parent); close(transaction); close(target_dir); free(leaf);
    return 0;
}
