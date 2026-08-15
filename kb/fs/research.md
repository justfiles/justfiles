read the docs [sync-node-identity.md](/Users/Xiaoxing.Hu@nib.co.nz/workspace/justfiles/tasks/sync-node-identity.md) for context. we are trying to make the [fs](/Users/Xiaoxing.Hu@nib.co.nz/workspace/justfiles/packages/fs/) sync very efficiently. and the work is growing out of hand. So it makes me rethink the whole architecture.

I tried very hard to make abstractions on top of all the implementations, so far we have sqlite, idb, real fs.
But the seam seems to grow each time we trying to add a feature, or resolve a edge case.
The biggest headache for me recently is the effcient sync, which we modeled after Dropbox's new solution.
It sounds okay on paper, but in real implementation, the seam keep growing, now we have added more concepts we'd like to in order to make it work together, the whole thing looks sketcher after each commit. Take a look at the latest work in PR #494, that one just trying to add ignore pattern, and it's a massive change.

So far, everything is built on top of the premises of packages/fs is a close mimic of a real linux file system, with inode and path mapping inside. I think that model is okay for a pure FS, but very awkward to implement sync on top of it. So it makes me think: are we doing it in the wrong way?

Here's what I am trying to achieve with this fs system:
1. it can be easily adapted to fs apis, exposed to code/agent to operate on and pretend it's a real fs underneath. easily plug into just-bash to be fs layer. and it can be implemented in any tech we want (real files on disk, db etc...), and run anywhere.
2. it can sync seamlessly, the synced version expose identical seam for the user, so the user don't even need to know anything about syncing, very similar to a dropbox folder. and the sync needs to be rock solid.
3. preferably, the sync implementation is composible, and flexible, P2P, central authority, all good. (this maybe a little stetch, I am okay for one of them)

Basically, it feels like the Dropbox layer for agents. The premises is very simple: I have a folder full of files, and I need it to sync.
I feel like that POSIX needs to be maintained to outward to the consumer of a Volume/FS, so it can be used anywhere expecting a FS. but the implementation facing interface can be totally different and minimized.
I need you to help me produce 3 things:

#1
Based on those requirements, forget about the existing data structure, can you help me figure out the full access pattern of the data, the objects need to reflect a File, with path, metadata, xattr etc.. that part we need to match closely to a real File on disk since that's what people/agent know and use. But the access pattern is a superset of a Real FS, so maybe mimicing too closely to a real FS underneath will do us detriment instead of helping. So I need you to help me with the table of access pattern.

#2
Secondly, based on the access pattern, what's the minimal data structure we need, the data structure are implementation-agnostic, we need the data shape first, without thinking about how they are stored, keep it to the minimal, so we can have a better understanding of the seams.

#3
Next, based on the minimal data structure and access pattern, design the minimal seam for implementations. Think what are the minimal things I need from the whatever storage you have back there (sqlite, posgresql, idb, files etc...), compress, compress and compress, this is the minimal things I need from you to make the system work.

after you produced it, review the whole picture, can we make it even simpler. try to minimize the seam, encapsulate the complexity. until there's absolotely nothing we can remove/change.

During the process, you can do research on prior arts, see if there are any good ideas that we can borrow.
