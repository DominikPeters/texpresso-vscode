// This code derived from https://github.com/component/rope

// The MIT License (MIT)

// Copyright (c) 2014 Automattic, Inc.

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

const SPLIT_LENGTH = 1000;
const JOIN_LENGTH = 500;
const REBALANCE_RATIO = 1.2;

const textEncoder = new TextEncoder();
function byteLength(str : string) : number {
  return textEncoder.encode(str).length;
}

/**
 * Creates a rope data structure
 *
 * @param {String} str - String to populate the rope.
 * @api public
 */

class Rope {
  private _value?: string;
  public length: number;
  public bytes: number;
  private _left?: Rope;
  private _right?: Rope;

  constructor(str: string) {
    this._value = str;
    this.length = str.length;
    this.bytes = byteLength(str);
    this.adjust();
  }

  private adjust() {
    if (typeof this._value != 'undefined') {
      if (this.length > SPLIT_LENGTH) {
        const divide = Math.floor(this.length / 2);
        this._left = new Rope(this._value.substring(0, divide));
        this._right = new Rope(this._value.substring(divide));
        delete this._value;
      }
    } else if (this._left && this._right) {
      if (this.length < JOIN_LENGTH) {
        this._value = this._left.toString() + this._right.toString();
        delete this._left;
        delete this._right;
      }
    }
  }

  public toString(): string {
    if (typeof this._value != 'undefined') {
      return this._value;
    } else if (this._left && this._right) {
      return this._left.toString() + this._right.toString();
    }
    return '';
  }

  public remove(start: number, end: number): void {
    if (start < 0 || start > this.length) throw new RangeError('Start is not within rope bounds.');
    if (end < 0 || end > this.length) throw new RangeError('End is not within rope bounds.');
    if (start > end) throw new RangeError('Start is greater than end.');
    if (typeof this._value != 'undefined') {
      this._value = this._value.substring(0, start) + this._value.substring(end);
      this.length = this._value.length;
      this.bytes = byteLength(this._value);
    } else if (this._left && this._right) {
      const leftLength = this._left.length;
      const leftStart = Math.min(start, leftLength);
      const leftEnd = Math.min(end, leftLength);
      const rightLength = this._right.length;
      const rightStart = Math.max(0, Math.min(start - leftLength, rightLength));
      const rightEnd = Math.max(0, Math.min(end - leftLength, rightLength));
      if (leftStart < leftLength) {
        this._left.remove(leftStart, leftEnd);
      }
      if (rightEnd > 0) {
        this._right.remove(rightStart, rightEnd);
      }
      this.length = this._left.length + this._right.length;
      this.bytes = this._left.bytes + this._right.bytes;
    }
    this.adjust();
  }

  public insert(position: number, value: string): void {
    if (position < 0 || position > this.length) throw new RangeError('position is not within rope bounds.');
    if (typeof this._value != 'undefined') {
      this._value = this._value.substring(0, position) + value.toString() + this._value.substring(position);
    } else if (this._left && this._right) {
      const leftLength = this._left.length;
      if (position < leftLength) {
        this._left.insert(position, value);
      } else {
        this._right.insert(position - leftLength, value);
      }
    }
    this.length += value.length;
    this.bytes += byteLength(value);
    this.adjust();
  }

  public rebuild(): void {
    if (this._left && this._right) {
      this._value = this._left.toString() + this._right.toString();
      delete this._left;
      delete this._right;
      this.adjust();
    }
  }

  public rebalance(): void {
    if (this._left && this._right) {
      if (this._left.length / this._right.length > REBALANCE_RATIO ||
          this._right.length / this._left.length > REBALANCE_RATIO) {
        this.rebuild();
      } else {
        this._left.rebalance();
        this._right.rebalance();
      }
    }
  }

  public byteOffset(position: number): number {
    if (typeof this._value != 'undefined') {
      return byteLength(this._value.substring(0, position));
    } else if (this._left && this._right) {
      const leftLength = this._left.length;
      if (position < leftLength) {
        return this._left.byteOffset(position);
      } else {
        return this._left.bytes + this._right.byteOffset(position - leftLength);
      }
    }
    return 0;
  }
}

export default Rope;